// Public Apple APIs only. All physical stream state belongs to the main queue.
// The Host transports requests; Kernel run release owns their lifetime.
#import <AppKit/AppKit.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <CoreMedia/CoreMedia.h>

extern void dc_computer_feedback_clear(uint32_t window, uint64_t generation);
static void Main(dispatch_block_t block) {
    if (NSThread.isMainThread) block(); else dispatch_async(dispatch_get_main_queue(), block);
}
static NSDictionary *Failure(NSString *message) { return @{ @"ok": @NO, @"error": message }; }
static NSDictionary *Success(id data) { return @{ @"ok": @YES, @"data": data }; }
static NSString *NativeError(NSError *error) {
    return [NSString stringWithFormat:@"%@: %ld: %@", error.domain, (long)error.code, error.localizedDescription];
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
@property uint64_t generation;
@property BOOL selectedByUser;
- (NSDictionary *)snapshot;
- (void)ended:(NSString *)reason;
@end
static NSMutableDictionary<NSString *, DCShare *> *Shares;
static uint64_t Generation = 0;
@interface DCPicker : NSObject <SCContentSharingPickerObserver>
@end
static DCPicker *PickerObserver;

static void UpdatePicker(void) {
    BOOL active = NO;
    for (DCShare *share in Shares.allValues) if (share.stream) active = YES;
    SCContentSharingPicker.sharedPicker.active = active;
}
static void Stop(DCShare *share, void (^complete)(NSError *)) {
    dc_computer_feedback_clear(share.window, share.generation);
    share.generation = ++Generation;
    SCStream *stream = share.stream;
    if (!stream) { complete(nil); return; }
    share.phase = @"stopping";
    [stream stopCaptureWithCompletionHandler:^(NSError *error) {
        Main(^{
            if (!error) { share.stream = nil; share.filter = nil; share.phase = @"stopped"; }
            else { share.phase = @"failed"; share.reason = NativeError(error); }
            UpdatePicker(); complete(error);
        });
    }];
}
@implementation DCShare
- (NSDictionary *)snapshot {
    return @{ @"state": _phase ?: @"inactive", @"windowId": @(_window), @"pid": @(_pid),
              @"app": _app ?: @"", @"generation": @(_generation),
              @"reason": _reason ?: @"", @"selectedByUser": @(_selectedByUser) };
}
- (void)ended:(NSString *)reason {
    dc_computer_feedback_clear(self.window, self.generation);
    self.reason = reason; self.phase = @"stopped"; self.generation = ++Generation;
    self.stream = nil; self.filter = nil; UpdatePicker();
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
    // The stream supplies the OS sharing experience. Tool observations use the
    // same filter with SCScreenshotManager; no unbounded video/frame archive.
}
@end

static SCStreamConfiguration *Configuration(SCContentFilter *filter) {
    SCStreamConfiguration *config = [SCStreamConfiguration new];
    CGSize points = filter.contentRect.size;
    double width = points.width * filter.pointPixelScale;
    double height = points.height * filter.pointPixelScale;
    double scale = fmin(1.0, 1600.0 / fmax(width, height));
    config.width = MAX(1, lround(width * scale)); config.height = MAX(1, lround(height * scale));
    config.showsCursor = NO; config.capturesAudio = NO;
    config.ignoreShadowsSingleWindow = YES;
    config.minimumFrameInterval = CMTimeMake(1, 2);
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
        for (DCShare *candidate in Shares.allValues) if (candidate.stream == stream) { share = candidate; break; }
        if (!share || !stream) return; // No run owns a new, unassociated OS stream.
        if (filter.includedWindows.count != 1) {
            share.reason = @"Select exactly one window"; Stop(share, ^(NSError *error) {}); return;
        }
        SCWindow *window = filter.includedWindows.firstObject;
        dc_computer_feedback_clear(share.window, share.generation);
        share.generation = ++Generation; share.phase = @"updating";
        [stream updateContentFilter:filter completionHandler:^(NSError *error) {
            Main(^{
                if (share.stream != stream || ![share.phase isEqual:@"updating"]) return;
                if (error) { share.reason = NativeError(error); Stop(share, ^(NSError *ignored) {}); return; }
                share.filter = filter; share.window = window.windowID;
                share.pid = window.owningApplication.processID; share.app = window.owningApplication.bundleIdentifier;
                share.selectedByUser = YES; share.phase = @"active";
            });
        }];
    });
}
@end

static void Screenshot(SCContentFilter *filter, NSString *path, DCReply *reply) {
    [SCScreenshotManager captureImageWithFilter:filter configuration:Configuration(filter) completionHandler:^(CGImageRef image, NSError *error) {
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
    share.app = window.owningApplication.bundleIdentifier; share.filter = filter;
    share.generation = ++Generation; share.phase = @"starting";
    SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:Configuration(filter) delegate:share];
    share.stream = stream; Shares[key] = share;
    NSError *outputError = nil;
    if (![stream addStreamOutput:share type:SCStreamOutputTypeScreen sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_UTILITY, 0) error:&outputError]) {
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

static void HandleRequest(NSDictionary *request, DCReply *reply) {
    if (!Shares) Shares = [NSMutableDictionary new];
    if ([request[@"operation"] isEqual:@"shutdown"]) {
        NSArray<DCShare *> *owned = Shares.allValues;
        if (!owned.count) { [reply finish:Success(@{ @"released": @YES })]; return; }
        __block NSUInteger remaining = owned.count;
        NSMutableArray *failures = [NSMutableArray new];
        for (DCShare *entry in owned) Stop(entry, ^(NSError *error) {
            if (error) [failures addObject:NativeError(error)]; else [Shares removeObjectForKey:entry.key];
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
    if ([operation isEqual:@"release"]) {
        if (!share) { [reply finish:Success(@{ @"released": @YES })]; return; }
        Stop(share, ^(NSError *error) {
            if (!error && Shares[key] == share) [Shares removeObjectForKey:key];
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
