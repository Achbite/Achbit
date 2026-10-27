// Public Apple APIs only. All physical stream state belongs to the main queue.
// The Host transports requests; Kernel run release owns their lifetime.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreImage/CoreImage.h>
#import <CoreVideo/CoreVideo.h>
#include <stdatomic.h>

extern void dc_computer_feedback_clear(uint32_t window, uint64_t generation);
static void Main(dispatch_block_t block) {
    if (NSThread.isMainThread) block(); else dispatch_async(dispatch_get_main_queue(), block);
}
static NSDictionary *Failure(NSString *message) { return @{ @"ok": @NO, @"error": message }; }
static NSDictionary *Success(id data) { return @{ @"ok": @YES, @"data": data }; }
static NSString *NativeError(NSError *error) {
    return [NSString stringWithFormat:@"%@: %ld: %@", error.domain, (long)error.code, error.localizedDescription];
}

// Draw explicit pointer pixels into the shared window's own backing surface,
// independently of NSImageView template-image state and appearance tinting.
@interface DCPointerView : NSView
@end
@implementation DCPointerView
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
    // Keep the desktop arrow at 26pt while the same shared window supplies
    // transparent padding for the system preview. Its tip remains at (3, 3)
    // within the centered glyph, matching indicator.rs's panel anchor.
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

void dc_computer_install_pointer_content(void *window) {
    NSPanel *panel = (__bridge NSPanel *)window;
    DCPointerView *view = [[DCPointerView alloc] initWithFrame:panel.contentView.bounds];
    view.wantsLayer = YES;
    panel.contentView = view;
    view.needsDisplay = YES;
}

@interface DCReply : NSObject
@property NSCondition *condition;
@property NSDictionary *value;
@property BOOL expired;
- (void)finish:(NSDictionary *)value;
- (BOOL)pending;
@end
@implementation DCReply
- (instancetype)init { if ((self = [super init])) _condition = [NSCondition new]; return self; }
- (void)finish:(NSDictionary *)value {
    [_condition lock]; if (!_expired && !_value) _value = value;
    [_condition signal]; [_condition unlock];
}
- (BOOL)pending {
    [_condition lock]; BOOL pending = !_expired && !_value; [_condition unlock]; return pending;
}
@end

@interface DCShare : NSObject <SCStreamDelegate, SCStreamOutput>
@property NSString *key;
@property NSString *phase;
@property NSString *reason;
@property SCStream *stream;
@property SCContentFilter *filter;
@property uint32_t window;
@property pid_t pid;
@property NSString *app;
@property NSString *title;
@property uint64_t generation;
@property BOOL selectedByUser;
@property BOOL pointerSource;
@property BOOL pointerWindowLookupPending;
@property NSTimeInterval pointerWindowDeadline;
@property DCShare *pointer;
@property (weak) DCShare *owner;
@property NSDictionary *pointerPosition;
@property NSDictionary *previewMetadata;
@property NSDictionary *latestFrame;
@property NSString *frameError;
@property CIContext *imageContext;
@property dispatch_queue_t outputQueue;
- (NSDictionary *)snapshot;
- (void)ended:(NSString *)reason;
- (void)publish;
@end
static NSMutableDictionary<NSString *, DCShare *> *Shares;
// The physical map above is main-thread-only. The read-only endpoint reads
// immutable published metadata and one encoded frame, never AppKit objects.
static NSMutableDictionary<NSString *, DCShare *> *PreviewSources;
static uint64_t Generation = 0;
static atomic_uint_fast64_t FrameSequence = 0;
@interface DCPicker : NSObject <SCContentSharingPickerObserver>
@end
static DCPicker *PickerObserver;

static void UpdatePicker(void) {
    BOOL active = NO;
    for (DCShare *share in Shares.allValues) if (share.stream || share.pointer.stream) active = YES;
    SCContentSharingPicker.sharedPicker.active = active;
}
static void StopSingle(DCShare *share, void (^complete)(NSError *)) {
    share.generation = ++Generation;
    @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
    SCStream *stream = share.stream;
    if (!stream) { share.phase = @"stopped"; complete(nil); return; }
    share.phase = @"stopping";
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        Main(^{
            if (!error) { share.stream = nil; share.filter = nil; share.phase = @"stopped"; }
            else { share.reason = NativeError(error); share.phase = @"failed"; }
            UpdatePicker(); complete(error);
        });
    }];
}
static void Stop(DCShare *share, void (^complete)(NSError *)) {
    if (!share.pointerSource) dc_computer_feedback_clear(share.window, share.generation);
    share.pointerPosition = nil;
    share.phase = @"stopping";
    @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
    // Both physical streams have one run owner. Failure is retained on the
    // affected source; stopping a companion never redirects the target.
    if (share.pointer) {
        StopSingle(share.pointer, ^(NSError *pointerError) {
            StopSingle(share, ^(NSError *targetError) { complete(targetError ?: pointerError); });
        });
    } else StopSingle(share, complete);
}
@implementation DCShare
@synthesize phase = _phase;
@synthesize pointerPosition = _pointerPosition;
- (NSString *)phase { @synchronized (self) { return _phase; } }
- (void)setPhase:(NSString *)phase { @synchronized (self) { _phase = phase; } [self publish]; }
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
        pointer[@"sharing"] = self.pointer ? self.pointer.snapshot : @{ @"state": @"inactive" };
        metadata[@"pointer"] = pointer;
    }
    @synchronized (self) { self.previewMetadata = [metadata copy]; }
}
- (NSDictionary *)snapshot {
    NSMutableDictionary *value = [@{ @"state": _phase ?: @"inactive", @"windowId": @(_window), @"pid": @(_pid),
              @"app": _app ?: @"", @"generation": @(_generation),
              @"reason": _reason ?: @"", @"selectedByUser": @(_selectedByUser),
              @"sourceKind": _pointerSource ? @"pointer" : @"target" } mutableCopy];
    if (_pointer) value[@"pointerSharing"] = _pointer.snapshot;
    return value;
}
- (void)ended:(NSString *)reason {
    if (!self.pointerSource) {
        dc_computer_feedback_clear(self.window, self.generation);
        self.pointerPosition = nil;
        if (self.pointer) StopSingle(self.pointer, ^(NSError *error) {});
    }
    @synchronized (self) { self.latestFrame = nil; self.frameError = nil; }
    self.reason = reason; self.generation = ++Generation;
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
        if (!status || status.integerValue != SCFrameStatusComplete) return;
        CVPixelBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
        if (!pixels) return;
        uint64_t generation = self.generation;
        CIImage *image = [CIImage imageWithCVPixelBuffer:pixels];
        CGImageRef bitmap = [self.imageContext createCGImage:image fromRect:image.extent];
        if (!bitmap) {
            @synchronized (self) { self.frameError = @"The shared window frame could not be decoded"; }
            return;
        }
        NSBitmapImageRep *representation = [[NSBitmapImageRep alloc] initWithCGImage:bitmap];
        NSData *jpeg = [representation representationUsingType:NSBitmapImageFileTypeJPEG
            properties:@{NSImageCompressionFactor: @0.7}];
        NSDictionary *frame = jpeg ? @{
            @"sequence": @(atomic_fetch_add(&FrameSequence, 1) + 1),
            @"capturedAt": [NSString stringWithFormat:@"%.0f", NSDate.date.timeIntervalSince1970 * 1000],
            @"width": @(CGImageGetWidth(bitmap)), @"height": @(CGImageGetHeight(bitmap)),
            @"dataUrl": [@"data:image/jpeg;base64," stringByAppendingString:[jpeg base64EncodedStringWithOptions:0]]
        } : nil;
        CGImageRelease(bitmap);
        @synchronized (self) {
            if (self.stream == stream && self.generation == generation && [self.phase isEqual:@"active"]) {
                // Only the latest frame is retained. It is never a tool image or
                // a journal artifact; observations still use SCScreenshotManager.
                self.latestFrame = frame;
                self.frameError = frame ? nil : @"The shared window frame could not be encoded";
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
    config.minimumFrameInterval = CMTimeMake(1, preview ? 8 : 2);
    config.queueDepth = 3;
    return config;
}

@implementation DCPicker
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didCancelForStream:(SCStream *)stream {
    // Cancelling the picker leaves the existing selection intact. It is not a stop.
}
- (void)contentSharingPickerStartDidFailWithError:(NSError *)error {
    NSLog(@"computer_sharing_picker_failed: %@", NativeError(error));
}
- (void)contentSharingPicker:(SCContentSharingPicker *)picker didUpdateWithFilter:(SCContentFilter *)filter forStream:(SCStream *)stream {
    Main(^{
        DCShare *share = nil;
        for (DCShare *candidate in Shares.allValues) {
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
        if (filter.includedWindows.count != 1) {
            share.reason = @"Select exactly one window"; Stop(share, ^(NSError *error) {}); return;
        }
        SCWindow *window = filter.includedWindows.firstObject;
        dc_computer_feedback_clear(share.window, share.generation);
        share.pointerPosition = nil;
        @synchronized (share) { share.latestFrame = nil; share.frameError = nil; }
        share.generation = ++Generation; share.phase = @"updating";
        void (^update)(NSError *) = ^(NSError *pointerError) {
            if (share.stream != stream || ![share.phase isEqual:@"updating"]) return;
            if (pointerError) {
                // Retain the failed companion under its run owner for release.
                share.reason = NativeError(pointerError);
                StopSingle(share, ^(NSError *ignored) {}); return;
            }
            share.pointer = nil;
            [stream updateContentFilter:filter completionHandler:^(NSError *error) {
                Main(^{
                    if (share.stream != stream || ![share.phase isEqual:@"updating"]) return;
                    if (error) { share.reason = NativeError(error); Stop(share, ^(NSError *ignored) {}); return; }
                    share.filter = filter; share.window = window.windowID;
                    share.pid = window.owningApplication.processID; share.app = window.owningApplication.bundleIdentifier;
                    share.title = window.title;
                    share.selectedByUser = YES; share.phase = @"active";
                });
            }];
        };
        if (share.pointer) StopSingle(share.pointer, update); else update(nil);
    });
}
@end

static void Screenshot(SCContentFilter *filter, NSString *path, DCReply *reply) {
    [SCScreenshotManager captureImageWithFilter:filter configuration:Configuration(filter, NO) completionHandler:^(CGImageRef image, NSError *error) {
        if (![reply pending]) return;
        if (error || !image) { [reply finish:Failure(error ? NativeError(error) : @"Screenshot returned no image")]; return; }
        NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        NSError *writeError = nil;
        if (!png || ![png writeToFile:path options:NSDataWritingAtomic error:&writeError]) {
            [reply finish:Failure(writeError ? NativeError(writeError) : @"PNG encoding failed")]; return;
        }
        [reply finish:Success(@{ @"width": @(CGImageGetWidth(image)), @"height": @(CGImageGetHeight(image)) })];
    }];
}

static void Begin(NSString *key, SCWindow *window, SCContentFilter *filter, DCReply *reply) {
    if (![reply pending]) return;
    if (!PickerObserver) {
        PickerObserver = [DCPicker new];
        [SCContentSharingPicker.sharedPicker addObserver:PickerObserver];
        // Every stream must belong to an admitted run. The system UI can change
        // existing streams, but must not create an unowned extra stream.
        SCContentSharingPicker.sharedPicker.maximumStreamCount = @0;
    }
    DCShare *share = [DCShare new];
    share.key = key; share.window = window.windowID; share.pid = window.owningApplication.processID;
    share.app = window.owningApplication.bundleIdentifier; share.title = window.title; share.filter = filter;
    share.generation = ++Generation; share.phase = @"starting";
    share.imageContext = [CIContext contextWithOptions:nil];
    share.outputQueue = dispatch_queue_create("com.achbite.achbit.control-preview", DISPATCH_QUEUE_SERIAL);
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:Configuration(filter, YES) delegate:share];
    share.stream = stream; Shares[key] = share;
    @synchronized (DCShare.class) {
        if (!PreviewSources) PreviewSources = [NSMutableDictionary new];
        PreviewSources[key] = share;
    }
    NSError *outputError = nil;
    if (![stream addStreamOutput:share type:SCStreamOutputTypeScreen sampleHandlerQueue:share.outputQueue error:&outputError]) {
        [share ended:NativeError(outputError)]; [reply finish:Failure(share.reason)]; return;
    }
    SCContentSharingPickerConfiguration *picker = [SCContentSharingPickerConfiguration new];
    picker.allowedPickerModes = SCContentSharingPickerModeSingleWindow;
    picker.allowsChangingSelectedContent = YES;
    [SCContentSharingPicker.sharedPicker setConfiguration:picker forStream:stream];
    UpdatePicker();
    [stream startCaptureWithCompletionHandler:^(NSError *error) {
        Main(^{
            if (error) { [share ended:NativeError(error)]; [reply finish:Failure(share.reason)]; return; }
            if (![reply pending] || Shares[key] != share) { Stop(share, ^(NSError *ignored) {}); return; }
            if (![share.phase isEqual:@"starting"]) { [reply finish:Failure(share.reason ?: @"Sharing stopped during startup")]; return; }
            share.phase = @"active"; [reply finish:Success(share.snapshot)];
        });
    }];
}

// Called only on the AppKit thread after the real pointer panel is displayed.
// The companion has its own SCWindow and stream, but never an input binding.
void dc_sharing_pointer_feedback(uint32_t targetWindow, uint64_t targetGeneration,
                                uint32_t pointerWindow, double x, double y, bool pulse) {
    DCShare *owner = nil;
    for (DCShare *candidate in Shares.allValues) {
        if (candidate.window == targetWindow && candidate.generation == targetGeneration && [candidate.phase isEqual:@"active"]) {
            owner = candidate; break;
        }
    }
    if (!owner) return;
    owner.pointerPosition = @{ @"x": @(x), @"y": @(y), @"coordinateSpace": @"target-normalized", @"pulse": @(pulse) };
    // In particular, a system-stopped pointer stream stays stopped for this
    // target binding. Rendering another action cannot silently re-share it.
    DCShare *pointer = owner.pointer;
    if (!pointer) {
        pointer = [DCShare new];
        pointer.key = owner.key; pointer.pointerSource = YES; pointer.owner = owner;
        pointer.window = pointerWindow; pointer.pid = NSProcessInfo.processInfo.processIdentifier;
        pointer.app = NSBundle.mainBundle.bundleIdentifier;
        pointer.title = @"Achbit Agent Pointer";
        pointer.generation = ++Generation; pointer.phase = @"starting";
        pointer.pointerWindowDeadline = NSProcessInfo.processInfo.systemUptime + 2.0;
        owner.pointer = pointer;
        [owner publish];
        // The deadline also settles startup if local feedback is hidden before
        // the next tick. A released or system-stopped binding is never revived.
        DCShare *pending = pointer;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
            if (Shares[owner.key] == owner && owner.pointer == pending && owner.generation == targetGeneration && [owner.phase isEqual:@"active"] && [pending.phase isEqual:@"starting"] && !pending.stream) {
                [pending ended:@"The Agent pointer window did not publish valid capture geometry within 2 seconds"]; pending.phase = @"failed";
            }
        });
    }
    if (![pointer.phase isEqual:@"starting"] || pointer.stream) return;
    if (!pointerWindow || pointer.window != pointerWindow) {
        [pointer ended:@"The Agent pointer WindowServer identity changed during startup"]; pointer.phase = @"failed"; return;
    }
    if (NSProcessInfo.processInfo.systemUptime >= pointer.pointerWindowDeadline) {
        [pointer ended:@"The Agent pointer window did not publish valid capture geometry within 2 seconds"]; pointer.phase = @"failed"; return;
    }
    if (pointer.pointerWindowLookupPending) return;
    pointer.pointerWindowLookupPending = YES;
    uint64_t pointerGeneration = pointer.generation;
    // A newly ordered panel can already have an ID while WindowServer still
    // reports a zero-size SCWindow. The existing feedback tick waits for its
    // real geometry before creating the one stream; it never restarts a stream.
    [SCShareableContent getCurrentProcessShareableContentWithCompletionHandler:^(SCShareableContent *content, NSError *error) {
        Main(^{
            if (Shares[owner.key] != owner || owner.pointer != pointer || owner.generation != targetGeneration || pointer.generation != pointerGeneration || ![owner.phase isEqual:@"active"] || ![pointer.phase isEqual:@"starting"] || pointer.stream) return;
            pointer.pointerWindowLookupPending = NO;
            if (error) { [pointer ended:NativeError(error)]; pointer.phase = @"failed"; return; }
            if (NSProcessInfo.processInfo.systemUptime >= pointer.pointerWindowDeadline) {
                [pointer ended:@"The Agent pointer window did not publish valid capture geometry within 2 seconds"]; pointer.phase = @"failed"; return;
            }
            SCWindow *window = nil;
            for (SCWindow *candidate in content.windows) {
                if (candidate.windowID == pointerWindow && candidate.owningApplication.processID == pointer.pid) { window = candidate; break; }
            }
            if (!window || !isfinite(window.frame.size.width) || !isfinite(window.frame.size.height) || CGRectIsEmpty(window.frame)) return;
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDesktopIndependentWindow:window];
            CGSize size = filter.contentRect.size;
            double scale = filter.pointPixelScale;
            if (!isfinite(scale) || scale <= 0 || !isfinite(size.width * scale) || !isfinite(size.height * scale) || size.width * scale < 1 || size.height * scale < 1) return;
            pointer.filter = filter;
            SCStreamConfiguration *configuration = Configuration(filter, NO);
            configuration.pixelFormat = kCVPixelFormatType_32BGRA;
            configuration.backgroundColor = NSColor.clearColor.CGColor;
            configuration.shouldBeOpaque = NO;
            // Preserve this window's transparent padding when the pointer is
            // near a display edge; the input target and tip do not move.
            configuration.ignoreGlobalClipSingleWindow = YES;
            configuration.minimumFrameInterval = CMTimeMake(1, 8);
            SCStream *stream = [[SCStream alloc] initWithFilter:pointer.filter configuration:configuration delegate:pointer];
            pointer.stream = stream;
            pointer.outputQueue = dispatch_queue_create("com.achbite.achbit.pointer-share", DISPATCH_QUEUE_SERIAL);
            NSError *outputError = nil;
            if (![stream addStreamOutput:pointer type:SCStreamOutputTypeScreen sampleHandlerQueue:pointer.outputQueue error:&outputError]) {
                [pointer ended:NativeError(outputError)]; pointer.phase = @"failed"; return;
            }
            SCContentSharingPickerConfiguration *picker = [SCContentSharingPickerConfiguration new];
            picker.allowedPickerModes = SCContentSharingPickerModeSingleWindow;
            picker.allowsChangingSelectedContent = NO;
            [SCContentSharingPicker.sharedPicker setConfiguration:picker forStream:stream];
            UpdatePicker();
            [stream startCaptureWithCompletionHandler:^(NSError *startError) {
                Main(^{
                    // Stop/release owns invalidated streams; a late startup
                    // callback must not overwrite or restart their state.
                    if (Shares[owner.key] != owner || owner.pointer != pointer || owner.generation != targetGeneration || pointer.generation != pointerGeneration || pointer.stream != stream || ![owner.phase isEqual:@"active"] || ![pointer.phase isEqual:@"starting"]) return;
                    if (startError) { [pointer ended:NativeError(startError)]; pointer.phase = @"failed"; return; }
                    pointer.phase = @"active";
                });
            }];
        });
    }];
}

static NSDictionary *Preview(DCShare *share, NSDictionary *request) {
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

static void HandleRequest(NSDictionary *request, DCReply *reply) {
    if (!Shares) Shares = [NSMutableDictionary new];
    if ([request[@"operation"] isEqual:@"shutdown"]) {
        NSArray<DCShare *> *owned = Shares.allValues;
        if (!owned.count) { [reply finish:Success(@{ @"released": @YES })]; return; }
        __block NSUInteger remaining = owned.count;
        NSMutableArray *failures = [NSMutableArray new];
        for (DCShare *entry in owned) Stop(entry, ^(NSError *error) {
            if (error) [failures addObject:NativeError(error)]; else {
                [Shares removeObjectForKey:entry.key];
                @synchronized (DCShare.class) { [PreviewSources removeObjectForKey:entry.key]; }
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
    DCShare *share = Shares[key];
    if ([operation isEqual:@"status"]) { [reply finish:Success(share ? share.snapshot : @{ @"state": @"inactive" })]; return; }
    if ([operation isEqual:@"preview"]) { [reply finish:Success(Preview(share, request))]; return; }
    if ([operation isEqual:@"release"]) {
        if (!share) { [reply finish:Success(@{ @"released": @YES })]; return; }
        Stop(share, ^(NSError *error) {
            if (!error && Shares[key] == share) {
                [Shares removeObjectForKey:key];
                @synchronized (DCShare.class) { [PreviewSources removeObjectForKey:key]; }
            }
            [reply finish:error ? Failure(NativeError(error)) : Success(@{ @"released": @YES })];
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
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
        Main(^{
            if (![reply pending]) return;
            if (error) { [reply finish:Failure(NativeError(error))]; return; }
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
            if (!ensure) { Screenshot(filter, request[@"path"], reply); return; }
            if (share) Stop(share, ^(NSError *stopError) {
                if (stopError) [reply finish:Failure(NativeError(stopError))]; else Begin(key, window, filter, reply);
            }); else Begin(key, window, filter, reply);
        });
    }];
}

// This entrypoint is intentionally independent of the main queue and the
// execute channel. Reading it cannot capture, encode, activate or acquire a run.
char *dc_sharing_preview(const char *json) {
    @autoreleasepool {
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
        NSString *session = request[@"binding"][@"sessionId"], *run = request[@"binding"][@"runId"];
        NSDictionary *response;
        if (![session isKindOfClass:NSString.class] || ![run isKindOfClass:NSString.class]) {
            response = Failure(@"Missing preview run binding");
        } else {
            NSString *key = [@[session, run] componentsJoinedByString:@"\n"];
            DCShare *share;
            @synchronized (DCShare.class) { share = PreviewSources[key]; }
            response = Success(Preview(share, request));
        }
        NSData *data = [NSJSONSerialization dataWithJSONObject:response options:0 error:nil];
        return strdup([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding].UTF8String);
    }
}

char *dc_sharing_request(const char *json) {
    @autoreleasepool {
        NSError *error = nil;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:&error];
        if (!request) return strdup("{\"ok\":false,\"error\":\"Invalid sharing request\"}");
        DCReply *reply = [DCReply new];
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
void dc_sharing_free(char *response) { free(response); }
