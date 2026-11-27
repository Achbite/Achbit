// Public Apple APIs only. All physical stream state belongs to the main queue.
// The Host transports requests; Kernel run release owns their lifetime.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#include <stdatomic.h>
#include <mach/mach_time.h>

// Monotonic executor diagnostics at the actual capture call sites; no probe or content in status.
static atomic_uint_fast64_t Enumerations, TargetStarts, PointerStarts, SingleShots, PNGWrites;
static NSDictionary *CaptureCounts(void) {
    return @{@"enumerations":@(atomic_load(&Enumerations)), @"targetStreamStarts":@(atomic_load(&TargetStarts)),
        @"pointerStreamStarts":@(atomic_load(&PointerStarts)), @"singleShots":@(atomic_load(&SingleShots)), @"pngWrites":@(atomic_load(&PNGWrites))};
}

extern void ac_computer_feedback_clear(uint32_t window, uint64_t generation);
static void Main(dispatch_block_t block) {
    if (NSThread.isMainThread) block(); else dispatch_async(dispatch_get_main_queue(), block);
}
static NSDictionary *Failure(NSString *message) { return @{ @"ok": @NO, @"error": message }; }
static NSDictionary *Success(id data) { return @{ @"ok": @YES, @"data": data }; }
static NSString *NativeError(NSError *error) {
    return [NSString stringWithFormat:@"%@: %ld: %@", error.domain, (long)error.code, error.localizedDescription];
}

static NSDictionary *NativeDetails(NSString *stage, NSError *error) {
    return @{ @"stage": stage, @"nativeDomain": error.domain, @"nativeCode": @(error.code), @"message": error.localizedDescription };
}
static NSDictionary *NativeFailure(NSString *stage, NSError *error) {
    return @{ @"ok": @NO, @"error": NativeError(error), @"diagnostics": NativeDetails(stage, error) };
}

// Draw explicit pointer pixels into the local feedback panel's backing surface,
// independently of NSImageView template-image state and appearance tinting.
@interface ACPointerView : NSView
@end
@implementation ACPointerView
- (BOOL)isOpaque { return NO; }
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    [NSColor.clearColor setFill];
    NSRectFillUsingOperation(self.bounds, NSCompositingOperationClear);
    NSBezierPath *arrow = [NSBezierPath bezierPath];
    [arrow moveToPoint:NSMakePoint(3, 3)];
    [arrow lineToPoint:NSMakePoint(3, 22)];
    [arrow lineToPoint:NSMakePoint(8, 17)];
    [arrow lineToPoint:NSMakePoint(12, 25)];
    [arrow lineToPoint:NSMakePoint(16, 23)];
    [arrow lineToPoint:NSMakePoint(12, 15)];
    [arrow lineToPoint:NSMakePoint(21, 15)];
    [arrow closePath];
    // Keep the local desktop arrow at 26pt. Its tip is at (3, 3) within
    // the centered glyph, matching indicator.rs's panel anchor.
    NSAffineTransform *position = [NSAffineTransform transform];
    [position translateXBy:(NSWidth(self.bounds) - 26.0) / 2.0 yBy:(NSHeight(self.bounds) - 26.0) / 2.0];
    [arrow transformUsingAffineTransform:position];
    [[NSColor colorWithCalibratedRed:0.2 green:0.38 blue:0.94 alpha:1] setFill];
    [arrow fill];
    [NSColor.whiteColor setStroke];
    arrow.lineWidth = 1;
    [arrow stroke];
}
@end

void ac_computer_install_pointer_content(void *window) {
    NSPanel *panel = (__bridge NSPanel *)window;
    ACPointerView *view = [[ACPointerView alloc] initWithFrame:panel.contentView.bounds];
    view.wantsLayer = YES;
    panel.contentView = view;
    view.needsDisplay = YES;
}

@interface ACReply : NSObject
@property NSCondition *condition;
@property NSDictionary *value;
@property BOOL expired;
- (void)finish:(NSDictionary *)value;
- (BOOL)pending;
@end
@implementation ACReply
- (instancetype)init { if ((self = [super init])) _condition = [NSCondition new]; return self; }
- (void)finish:(NSDictionary *)value {
    [_condition lock]; if (!_expired && !_value) _value = value;
    [_condition signal]; [_condition unlock];
}
- (BOOL)pending {
    [_condition lock]; BOOL pending = !_expired && !_value; [_condition unlock]; return pending;
}
@end

@interface ACShare : NSObject <SCStreamDelegate, SCStreamOutput>
@property NSString *key;
@property NSString *phase;
@property NSString *reason;
@property SCStream *stream;
// Main queue only: all callers join the one in-flight stop of this physical stream.
@property NSMutableArray<void (^)(NSError *)> *stopWaiters;
@property NSDictionary *stopDiagnostic;
@property SCContentFilter *filter;
@property uint32_t window;
@property pid_t pid;
@property NSString *app;
@property NSString *title;
@property uint64_t generation;
@property BOOL selectedByUser;
@property BOOL pointerSource;
// Tool bitmap and display timestamp are replaced together; preview JPEG is separate.
@property NSDictionary *toolFrame;
@property uint64_t notBefore;
@property ACShare *pointer;
@property (weak) ACShare *owner;
@property (nonatomic) NSDictionary *pointerPosition;
@property NSDictionary *previewMetadata;
@property NSDictionary *latestFrame;
@property NSString *frameError;
@property CIContext *imageContext;
@property dispatch_queue_t outputQueue;
- (NSDictionary *)snapshot;
- (void)ended:(NSString *)reason;
- (void)publish;
@end
static NSMutableDictionary<NSString *, ACShare *> *Shares;
// The physical map above is main-thread-only. The read-only endpoint reads
// immutable published metadata and one encoded frame, never AppKit objects.
static NSMutableDictionary<NSString *, ACShare *> *PreviewSources;
// A preview gesture carries a generation across the Host connection. Do not
// recycle a previous process's generation when a new helper shares the same window.
static uint64_t NextGeneration(void) {
    static uint64_t previous;
    previous = MAX(previous + 1, clock_gettime_nsec_np(CLOCK_UPTIME_RAW) / 1000);
    return previous;
}
static atomic_uint_fast64_t FrameSequence = 0;
@interface ACPicker : NSObject <SCContentSharingPickerObserver>
@end
static ACPicker *PickerObserver;

static void UpdatePicker(void) {
    BOOL active = NO;
    for (ACShare *share in Shares.allValues) if (share.stream || share.pointer.stream) active = YES;
    SCContentSharingPicker.sharedPicker.active = active;
}
static void StopSingle(ACShare *share, void (^complete)(NSError *)) {
    if (share.stopWaiters) { [share.stopWaiters addObject:[complete copy]]; return; }
    SCStream *stream = share.stream;
    if (!stream) { share.phase = @"stopped"; complete(nil); return; }
    share.stopWaiters = [NSMutableArray arrayWithObject:[complete copy]];
    share.generation = NextGeneration(); share.phase = @"stopping";
    @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        Main(^{
            BOOL alreadyStopped = error && [error.domain isEqual:SCStreamErrorDomain] && error.code == SCStreamErrorAttemptToStopStreamState;
            NSError *failure = alreadyStopped ? nil : error;
            // The delegate may independently have ended this exact stream. A late
            // completion cannot mutate a different stream or erase a real error.
            if (error) share.stopDiagnostic = NativeDetails(@"stopCapture", error);
            if (share.stream == stream) {
                if (!failure) { share.stream = nil; share.filter = nil; share.phase = @"stopped"; }
                else { share.reason = NativeError(failure); share.phase = @"failed"; }
            }
            NSArray *waiters = share.stopWaiters; share.stopWaiters = nil;
            UpdatePicker();
            for (void (^waiter)(NSError *) in waiters) waiter(failure);
        });
    }];
}
static void Stop(ACShare *share, void (^complete)(NSError *)) {
    if (!share.pointerSource) ac_computer_feedback_clear(share.window, share.generation);
    share.pointerPosition = nil;
    share.phase = @"stopping";
    @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
    // Both physical streams have one run owner. Failure is retained on the
    // affected source; stopping a companion never redirects the target.
    ACShare *pointer = share.pointer;
    __block NSUInteger pending = pointer ? 2 : 1;
    __block NSError *failure = nil;
    void (^finished)(NSError *) = ^(NSError *error) {
        if (error && !failure) failure = error;
        if (--pending == 0) complete(failure);
    };
    StopSingle(share, finished);
    if (pointer) StopSingle(pointer, finished);
}
@implementation ACShare
@synthesize phase = _phase;
@synthesize pointerPosition = _pointerPosition;
- (NSString *)phase { @synchronized (self) { return _phase; } }
- (void)setPhase:(NSString *)phase {
    @synchronized (self) {
        _phase = phase;
        if (![phase isEqual:@"active"]) { self.toolFrame = nil; self.latestFrame = nil; self.frameError = nil; }
    }
    [self publish];
}
- (void)setPointerPosition:(NSDictionary *)position { _pointerPosition = position; [self publish]; }
- (void)publish {
    if (self.pointerSource) { [self.owner publish]; return; }
    CGSize size = self.filter ? self.filter.contentRect.size : CGSizeZero;
    NSMutableDictionary *metadata = [@{ @"state": self.phase ?: @"inactive", @"reason": self.reason ?: @"",
        @"target": @{ @"windowId": @(self.window), @"pid": @(self.pid), @"app": self.app ?: @"", @"title": self.title ?: @"",
            @"generation": @(self.generation), @"width": @(size.width), @"height": @(size.height) }
    } mutableCopy];
    if ([self.phase isEqual:@"active"] && self.pointerPosition) {
        NSMutableDictionary *pointer = [self.pointerPosition mutableCopy];
        // Run-local overlay metadata. No separate sharing item is created.
        if (self.pointer) pointer[@"sharing"] = self.pointer.snapshot;
        metadata[@"pointer"] = pointer;
    }
    @synchronized (self) { self.previewMetadata = [metadata copy]; }
}
- (NSDictionary *)snapshot {
    NSMutableDictionary *value = [@{ @"state": _phase ?: @"inactive", @"windowId": @(_window), @"pid": @(_pid),
              @"app": _app ?: @"", @"generation": @(_generation),
              @"reason": _reason ?: @"", @"selectedByUser": @(_selectedByUser),
              @"sourceKind": _pointerSource ? @"pointer" : @"target" } mutableCopy];
    if (_stopDiagnostic) value[@"stopDiagnostic"] = _stopDiagnostic;
    if (_pointer) value[@"pointerSharing"] = _pointer.snapshot;
    return value;
}
- (void)ended:(NSString *)reason {
    if (!self.pointerSource) {
        ac_computer_feedback_clear(self.window, self.generation);
        self.pointerPosition = nil;
        if (self.pointer) StopSingle(self.pointer, ^(NSError *error) {});
    }
    @synchronized (self) { self.latestFrame = nil; self.frameError = nil; }
    self.reason = reason; self.generation = NextGeneration();
    self.stream = nil; self.filter = nil; self.phase = @"stopped"; UpdatePicker();
}
- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    Main(^{ if (self.stream == stream) [self ended:NativeError(error)]; });
}
- (void)streamDidBecomeInactive:(SCStream *)stream {
    Main(^{ if (self.stream == stream) {
        self.reason = @"The shared window closed";
        Stop(self, ^(NSError *error) {});
    }});
}
- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sample ofType:(SCStreamOutputType)type {
    if (self.pointerSource || type != SCStreamOutputTypeScreen || !CMSampleBufferIsValid(sample)) return;
    @autoreleasepool {
        NSArray *attachments = (__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, false);
        NSNumber *status = attachments.firstObject[SCStreamFrameInfoStatus];
        NSNumber *time = attachments.firstObject[SCStreamFrameInfoDisplayTime];
        if (!status || status.integerValue != SCFrameStatusComplete || !time.unsignedLongLongValue) return;
        CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
        if (!pixels) return;
        uint64_t generation = self.generation;
        CIImage *image = [CIImage imageWithCVPixelBuffer:pixels];
        CGImageRef bitmap = [self.imageContext createCGImage:image fromRect:image.extent];
        if (!bitmap) {
            @synchronized (self) { self.frameError = @"The shared window frame could not be decoded"; }
            return;
        }
        const double scale = MIN(1., 720. / MAX(CGImageGetWidth(bitmap), CGImageGetHeight(bitmap)));
        CIImage *small = [image imageByApplyingTransform:CGAffineTransformMakeScale(scale, scale)];
        CGImageRef thumbnail = [self.imageContext createCGImage:small fromRect:CGRectIntegral(small.extent)];
        NSBitmapImageRep *representation = thumbnail ? [[NSBitmapImageRep alloc] initWithCGImage:thumbnail] : nil;
        NSData *jpeg = [representation representationUsingType:NSBitmapImageFileTypeJPEG
            properties:@{NSImageCompressionFactor: @0.7}];
        NSNumber *sequence = @(atomic_fetch_add(&FrameSequence, 1) + 1);
        NSDictionary *tool = @{@"bitmap":CFBridgingRelease(bitmap), @"displayTime":time, @"sequence":sequence,
            @"contentRect":attachments.firstObject[SCStreamFrameInfoContentRect] ?: @{},
            @"scaleFactor":attachments.firstObject[SCStreamFrameInfoScaleFactor] ?: @0,
            @"contentScale":attachments.firstObject[SCStreamFrameInfoContentScale] ?: @0};
        NSDictionary *frame = jpeg ? @{
            @"sequence": sequence,
            @"capturedAt": [NSString stringWithFormat:@"%.0f", NSDate.date.timeIntervalSince1970 * 1000],
            @"width": @(CGImageGetWidth(thumbnail)), @"height": @(CGImageGetHeight(thumbnail)),
            @"dataUrl": [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]]
        } : nil;
        NSString *previewError = thumbnail ? @"The shared window frame could not be encoded" : @"The shared window preview could not be created";
        if (thumbnail) CGImageRelease(thumbnail);
        @synchronized (self) {
            if (self.stream == stream && self.generation == generation && time.unsignedLongLongValue > self.notBefore &&
                ([self.phase isEqual:@"active"] || [self.phase isEqual:@"starting"])) {
                // The complete surface is the tool image; a missing thumbnail or encoding only
                // affects the GUI preview and must not discard a frame an observation can use.
                self.toolFrame = tool;
                self.latestFrame = frame;
                self.frameError = frame ? nil : previewError;
            }
        }
    }
}
@end

static SCStreamConfiguration *Configuration(SCContentFilter *filter, BOOL preview) {
    SCStreamConfiguration *config = [SCStreamConfiguration new];
    CGSize points = filter.contentRect.size;
    double width = points.width * filter.pointPixelScale;
    double height = points.height * filter.pointPixelScale;
    double scale = fmin(1.0, (preview ? 720.0 : 1600.0) / fmax(width, height));
    config.width = MAX(1, lround(width * scale)); config.height = MAX(1, lround(height * scale));
    config.showsCursor = NO; config.capturesAudio = NO;
    config.ignoreShadowsSingleWindow = YES;
    // The full independent window fills the output. No shadow, display clipping,
    // padded destination or letterboxing; refuse unverified geometry at readout.
    config.ignoreGlobalClipSingleWindow = YES; config.scalesToFit = YES;
    config.preservesAspectRatio = NO;
    config.minimumFrameInterval = CMTimeMake(1, preview ? 8 : 2);
    config.queueDepth = 3;
    return config;
}

@implementation ACPicker
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
    // Cancelling the picker leaves the existing selection intact. It is not a stop.
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
    NSLog(@"computer_sharing_picker_failed: %@", NativeError(error));
}
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didUpdateWithFilter:(SCContentFilter *)filter forStream:(SCStream *)stream {
    Main(^{
        ACShare *share = nil;
        for (ACShare *candidate in Shares.allValues) {
            if (candidate.stream == stream) { share = candidate; break; }
            if (candidate.pointer.stream == stream) { share = candidate.pointer; break; }
        }
        if (!share || !stream) return; // No run owns a new, unassociated OS stream.
        if (share.pointerSource) {
            // The companion is a fixed source, never an alternate input target.
            if (filter.includedWindows.count != 1 || filter.includedWindows.firstObject.windowID != share.window) {
                share.reason = @"The Agent pointer sharing source cannot be changed";
                StopSingle(share, ^(NSError *error) {});
            }
            return;
        }
        if (filter.style != SCShareableContentStyleWindow || filter.includedWindows.count != 1) {
            share.reason = @"Select exactly one window"; Stop(share, ^(NSError *error) {}); return;
        }
        SCWindow *window = filter.includedWindows.firstObject;
        ac_computer_feedback_clear(share.window, share.generation);
        share.pointerPosition = nil;
        @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
        share.generation = NextGeneration(); share.phase = @"updating";
        uint64_t changing = share.generation;
        void (^update)(NSError *) = ^(NSError *pointerError) {
            if (share.stream != stream || share.generation != changing || ![share.phase isEqual:@"updating"]) return;
            if (pointerError) {
                // Retain the failed companion under its run owner for release.
                share.reason = NativeError(pointerError);
                StopSingle(share, ^(NSError *ignored) {}); return;
            }
            share.pointer = nil;
            [stream updateContentFilter:filter completionHandler:^(NSError *error) {
                Main(^{
                    if (share.stream != stream || share.generation != changing || ![share.phase isEqual:@"updating"]) return;
                    if (error) { share.reason = NativeError(error); Stop(share, ^(NSError *ignored) {}); return; }
                    [stream updateConfiguration:Configuration(filter, NO) completionHandler:^(NSError *resizeError) { Main(^{
                        if (share.stream != stream || share.generation != changing || ![share.phase isEqual:@"updating"]) return;
                        if (resizeError) { share.reason = NativeError(resizeError); Stop(share, ^(NSError *ignored) {}); return; }
                        share.filter = filter; share.window = window.windowID;
                        share.pid = window.owningApplication.processID; share.app = window.owningApplication.bundleIdentifier;
                        share.title = window.title;
                        // Queued old samples keep their original WindowServer display time.
                        share.notBefore = mach_absolute_time();
                        share.selectedByUser = YES; share.phase = @"active";
                    }); }];
                });
            }];
        };
        if (share.pointer) StopSingle(share.pointer, update); else update(nil);
    });
}
@end

static void Screenshot(SCContentFilter *filter, NSString *path, ACReply *reply, BOOL (^stillAllowed)(void)) {
    atomic_fetch_add(&SingleShots, 1);
    [SCScreenshotManager captureImageWithFilter:filter configuration:Configuration(filter, NO) completionHandler:^(CGImageRef image, NSError *error) {
        if (![reply pending]) return;
        if (error || !image) { [reply finish:error ? NativeFailure(@"captureImage", error) : Failure(@"Screenshot returned no image")]; return; }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSUInteger width = CGImageGetWidth(image), height = CGImageGetHeight(image);
        Main(^{
            if (!reply.pending || !stillAllowed()) { [reply finish:Failure(@"Sharing changed during one-shot capture")]; return; }
            NSError *writeError = nil;
            if (!png || ![png writeToFile:path options:NSDataWritingAtomic error:&writeError]) {
                [reply finish:writeError ? NativeFailure(@"writePNG", writeError) : Failure(@"PNG encoding failed")]; return;
            }
            atomic_fetch_add(&PNGWrites, 1);
            [reply finish:Success(@{ @"width": @(width), @"height": @(height) })];
        });
    }];
}

static void Begin(NSString *key, SCWindow *window, SCContentFilter *filter, ACReply *reply) {
    if (![reply pending]) return;
    if (!window || !filter || CGRectIsEmpty(filter.contentRect) || !isfinite(filter.pointPixelScale) || filter.pointPixelScale <= 0) {
        [reply finish:Failure(@"Invalid exact-window capture geometry")]; return;
    }
    if (!PickerObserver) {
        PickerObserver = [ACPicker new];
        [SCContentSharingPicker.sharedPicker addObserver:PickerObserver];
        // Every stream must belong to an admitted run. The system UI can change
        // existing streams, but must not create an unowned extra stream.
        SCContentSharingPicker.sharedPicker.maximumStreamCount = @0;
    }
    ACShare *share = [ACShare new];
    share.key = key; share.window = window.windowID; share.pid = window.owningApplication.processID;
    share.app = window.owningApplication.bundleIdentifier; share.title = window.title; share.filter = filter;
    share.generation = NextGeneration(); share.phase = @"starting";
    share.imageContext = [CIContext contextWithOptions:nil];
    share.outputQueue = dispatch_queue_create("com.achbite.achbit.control-preview", DISPATCH_QUEUE_SERIAL);
    share.notBefore = mach_absolute_time();
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:Configuration(filter, NO) delegate:share];
    share.stream = stream; Shares[key] = share;
    @synchronized (ACShare.class) {
        if (!PreviewSources) PreviewSources = [NSMutableDictionary new];
        PreviewSources[key] = share;
    }
    NSError *outputError = nil;
    if (![stream addStreamOutput:share type:SCStreamOutputTypeScreen sampleHandlerQueue:share.outputQueue error:&outputError]) {
        [share ended:NativeError(outputError)]; [reply finish:NativeFailure(@"addStreamOutput", outputError)]; return;
    }
    SCContentSharingPickerConfiguration *picker = [SCContentSharingPickerConfiguration new];
    picker.allowedPickerModes = SCContentSharingPickerModeSingleWindow;
    picker.allowsChangingSelectedContent = YES;
    [SCContentSharingPicker.sharedPicker setConfiguration:picker forStream:stream];
    UpdatePicker();
    atomic_fetch_add(share.pointerSource ? &PointerStarts : &TargetStarts, 1);
    [stream startCaptureWithCompletionHandler:^(NSError *error) {
        Main(^{
            if (error) { if (share.stream == stream && [share.phase isEqual:@"starting"]) [share ended:NativeError(error)]; [reply finish:NativeFailure(@"startCapture", error)]; return; }
            if (![reply pending] || Shares[key] != share) { Stop(share, ^(NSError *ignored) {}); return; }
            if (![share.phase isEqual:@"starting"]) { [reply finish:Failure(share.reason ?: @"Sharing stopped during startup")]; return; }
            share.phase = @"active"; [reply finish:Success(share.snapshot)];
        });
    }];
}

// The mouse-through AppKit panel is local; GUI thumbnails draw these coordinates.
void ac_sharing_pointer_feedback(uint32_t targetWindow, uint64_t targetGeneration,
                                double x, double y, bool pulse) {
    ACShare *owner = nil;
    for (ACShare *candidate in Shares.allValues) {
        if (candidate.window == targetWindow && candidate.generation == targetGeneration && [candidate.phase isEqual:@"active"]) {
            owner = candidate; break;
        }
    }
    if (!owner) return;
    owner.pointerPosition = @{ @"x": @(x), @"y": @(y), @"coordinateSpace": @"target-normalized", @"pulse": @(pulse) };

}

#include "tool_frame.h"

static NSDictionary *Preview(ACShare *share, NSDictionary *request) {
    if (!share) return @{ @"state": @"inactive" };
    @synchronized (share) {
        NSMutableDictionary *value = [share.previewMetadata mutableCopy];
        if ([value[@"state"] isEqual:@"active"]) {
            NSDictionary *frame = share.latestFrame;
            if (frame && ![frame[@"sequence"] isEqual:request[@"afterSequence"]]) value[@"frame"] = frame;
            if (share.frameError) value[@"frameError"] = share.frameError;
        }
        return value ?: @{ @"state": @"inactive" };
    }
}

static void HandleRequest(NSDictionary *request, ACReply *reply) {
    if (!Shares) Shares = [NSMutableDictionary new];
    if ([request[@"operation"] isEqual:@"shutdown"]) {
        NSArray<ACShare *> *owned = Shares.allValues;
        if (!owned.count) { [reply finish:Success(@{ @"released": @YES })]; return; }
        __block NSUInteger remaining = owned.count;
        NSMutableArray *failures = [NSMutableArray new];
        for (ACShare *entry in owned) Stop(entry, ^(NSError *error) {
            if (error) [failures addObject:NativeError(error)]; else {
                [Shares removeObjectForKey:entry.key];
                @synchronized (ACShare.class) { [PreviewSources removeObjectForKey:entry.key]; }
            }
            if (--remaining == 0) [reply finish:failures.count ? Failure([failures componentsJoinedByString:@"; "]) : Success(@{ @"released": @YES })];
        }); return;
    }
    NSDictionary *binding = request[@"binding"];
    NSString *session = binding[@"sessionId"], *run = binding[@"runId"];
    NSString *operation = request[@"operation"];
    if (![session isKindOfClass:NSString.class] || ![run isKindOfClass:NSString.class]) {
        [reply finish:Failure(@"Missing run binding")]; return;
    }
    NSString *key = [@[session, run] componentsJoinedByString:@"\n"];
    ACShare *share = Shares[key];
    if ([operation isEqual:@"status"]) {
        NSMutableDictionary *value = [share.snapshot mutableCopy] ?: [@{@"state":@"inactive"} mutableCopy];
        value[@"executorCaptureCounts"] = CaptureCounts(); [reply finish:Success(value)]; return;
    }
    if ([operation isEqual:@"frame"]) {
        ReadToolFrame(share, request, reply, NSProcessInfo.processInfo.systemUptime + 2.0); return;
    }
    if ([operation isEqual:@"preview"]) { [reply finish:Success(Preview(share, request))]; return; }
    if ([operation isEqual:@"release"] || [operation isEqual:@"enterAX"]) {
        if (!share) { [reply finish:Success(@{ @"released": @YES })]; return; }
        if (([operation isEqual:@"enterAX"] || [request[@"forImageReplacement"] boolValue]) && (![share.phase isEqual:@"active"] || share.selectedByUser ||
                (share.pointer && ![share.pointer.phase isEqual:@"active"] && ![share.pointer.phase isEqual:@"starting"]))) {
            [reply finish:Failure(@"Sharing was stopped, changed or unavailable. Finish this run; its selection will not be restarted.")]; return;
        }
        Stop(share, ^(NSError *error) {
            if (!error && Shares[key] == share) {
                [Shares removeObjectForKey:key];
                @synchronized (ACShare.class) { [PreviewSources removeObjectForKey:key]; }
            }
            if (error) { [reply finish:NativeFailure(@"stopCapture", error)]; return; }
            NSMutableDictionary *receipt = [@{ @"released": @YES } mutableCopy];
            if (share.stopDiagnostic) receipt[@"targetStop"] = share.stopDiagnostic;
            if (share.pointer.stopDiagnostic) receipt[@"pointerStop"] = share.pointer.stopDiagnostic;
            [reply finish:Success(receipt)];
        }); return;
    }
    if ([operation isEqual:@"validate"]) {
        BOOL valid = [share.phase isEqual:@"active"] && share.window == [request[@"windowId"] unsignedIntValue]
            && share.generation == [request[@"generation"] unsignedLongLongValue];
        [reply finish:valid ? Success(share.snapshot) : Failure([NSString stringWithFormat:@"Sharing changed or stopped: %@", share.snapshot ?: @{}])]; return;
    }
    BOOL ensure = [operation isEqual:@"ensure"];
    if (!ensure && ![operation isEqual:@"capture"]) { [reply finish:Failure(@"Unknown sharing operation")]; return; }
    id windowValue = request[@"windowId"];
    if (windowValue && windowValue != NSNull.null && ![windowValue isKindOfClass:NSNumber.class]) {
        [reply finish:Failure(@"Invalid capture windowId")]; return;
    }
    uint32_t windowID = [windowValue isKindOfClass:NSNumber.class] ? [windowValue unsignedIntValue] : 0;
    if (share && ![share.phase isEqual:@"active"]) {
        [reply finish:Failure([NSString stringWithFormat:@"Sharing is unavailable: %@", share.snapshot])]; return;
    }
    if (share && share.window == windowID && ensure) { [reply finish:Success(share.snapshot)]; return; }
    if (share.selectedByUser && share.window != windowID) {
        [reply finish:Failure([NSString stringWithFormat:@"Use the window selected by the user: %@", share.snapshot])]; return;
    }
    uint64_t generation = share.generation;
    atomic_fetch_add(&Enumerations, 1);
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
        Main(^{
            if (![reply pending]) return;
            if (error) { [reply finish:NativeFailure(@"enumerateShareableContent", error)]; return; }
            // A system stop or selection change may have arrived during enumeration.
            if (share && (Shares[key] != share || share.generation != generation || ![share.phase isEqual:@"active"])) {
                [reply finish:Failure(@"Sharing changed during capture preparation")]; return;
            }
            SCWindow *window = nil; SCContentFilter *filter = nil;
            if (windowID) {
                for (SCWindow *candidate in content.windows) if (candidate.windowID == windowID) { window = candidate; break; }
                if (window) filter = share.window == windowID ? share.filter : [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            } else if (!ensure && [request[@"display"] isEqual:@"primary"]) {
                for (SCDisplay *display in content.displays) if (display.displayID == CGMainDisplayID()) {
                    filter = [[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]]; break;
                }
            }
            if (!filter) { [reply finish:Failure(@"The exact capture target is unavailable")]; return; }
            if (!ensure) {
                Screenshot(filter,request[@"path"],reply,^BOOL{
                    return !share || (Shares[key] == share && share.generation == generation && [share.phase isEqual:@"active"]);
                }); return;
            }
            if (share) Stop(share, ^(NSError *stopError) {
                if (stopError) [reply finish:NativeFailure(@"stopCapture", stopError)]; else Begin(key, window, filter, reply);
            }); else Begin(key, window, filter, reply);
        });
    }];
}

// This entrypoint is intentionally independent of the main queue and the
// execute channel. Reading it cannot capture, encode, activate or acquire a run.
char *ac_sharing_preview(const char *json) {
    @autoreleasepool {
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSString *session = request[@"binding"][@"sessionId"], *run = request[@"binding"][@"runId"];
        NSDictionary *response;
        if (![session isKindOfClass:NSString.class] || ![run isKindOfClass:NSString.class]) {
            response = Failure(@"Missing preview run binding");
        } else {
            NSString *key = [@[session, run] componentsJoinedByString:@"\n"];
            ACShare *share;
            @synchronized (ACShare.class) { share = PreviewSources[key]; }
            response = Success(Preview(share, request));
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}

char *ac_sharing_request(const char *json) {
    @autoreleasepool {
        NSError *error = nil;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
        if (!request) return strdup("{\"ok\":false,\"error\":\"Invalid sharing request\"}");
        ACReply *reply = [ACReply new];
        Main(^{ HandleRequest(request, reply); });
        [reply.condition lock];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:20];
        while (!reply.value && [reply.condition waitUntilDate:deadline]) {}
        if (!reply.value) reply.expired = YES;
        NSDictionary *value = reply.value ?: Failure(@"ScreenCaptureKit operation timed out");
        [reply.condition unlock];
        NSData *encoded = [NSJSONSerialization dataWithJSONObject:value options:0 error:&error];
        return strdup([[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding].UTF8String);
    }
}
void ac_sharing_free(char *response) { free(response); }
