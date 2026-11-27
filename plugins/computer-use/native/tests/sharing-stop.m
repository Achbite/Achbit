// Native Debug-package contract test. Only the physical stream and picker UI
// are stand-ins. Run release/status/preview and both OS delegate callbacks through
// the same ObjC implementation as the packaged helper; no capture permission needed.
#import <objc/runtime.h>
#import "../src/sharing.m"
#include <assert.h>
void ac_computer_feedback_clear(uint32_t window, uint64_t generation) {}
@interface StopRecorder : NSObject
@property NSUInteger calls;
@property(copy) void (^ack)(NSError *);
@end
@implementation StopRecorder
- (void)stopCaptureWithCompletionHandler:(void (^)(NSError *))handler {
    ++_calls; assert(!_ack); _ack = handler;
}
- (void)finish:(NSError *)error { void (^ack)(NSError *) = _ack; assert(ack); _ack = nil; ack(error); }
@end
static ACReply *Release(void) {
    ACReply *reply = [ACReply new];
    HandleRequest(@{@"operation":@"release", @"binding":@{@"sessionId":@"s", @"runId":@"r"}}, reply);
    return reply;
}
static void Scenario(BOOL delegateFirst, NSError *pointerError, BOOL expectFailure) {
    ACShare *owner = [ACShare new], *pointer = [ACShare new];
    StopRecorder *targetStream = [StopRecorder new], *pointerStream = [StopRecorder new];
    owner.key = @"s\nr"; owner.stream = (id)targetStream; owner.window = 7; owner.phase = @"active";
    pointer.owner = owner; pointer.pointerSource = YES; owner.pointer = pointer;
    pointer.stream = (id)pointerStream; pointer.phase = @"active";
    Shares = [@{owner.key:owner} mutableCopy]; PreviewSources = [Shares mutableCopy];
    owner.latestFrame = @{@"sequence":@1};
    NSError *already = [NSError errorWithDomain:SCStreamErrorDomain code:SCStreamErrorAttemptToStopStreamState userInfo:nil];
    if (delegateFirst) [pointer stream:(id)pointerStream didStopWithError:already];
    // A system window-inactive event overlaps two independent cleanup callers.
    [owner streamDidBecomeInactive:(id)targetStream];
    ACReply *a = Release(), *b = Release();
    assert(!a.value && !b.value && !owner.latestFrame);
    assert(targetStream.calls == 1 && pointerStream.calls == (delegateFirst ? 0 : 1));
    if (!expectFailure) [owner stream:(id)targetStream didStopWithError:already];
    [targetStream finish:already];
    if (!delegateFirst) {
        assert(!a.value && !b.value && Shares[owner.key] == owner);
        [pointerStream finish:pointerError];
    }
    for (ACReply *reply in @[a,b]) assert([reply.value[@"ok"] boolValue] == !expectFailure);
    if (expectFailure) {
        assert(Shares[owner.key] == owner && !owner.stream && pointer.stream == (id)pointerStream);
        assert([a.value[@"diagnostics"][@"nativeCode"] integerValue] == pointerError.code);
        assert([a.value[@"diagnostics"][@"nativeDomain"] isEqual:pointerError.domain]);
        ACReply *retry = Release(); assert(!retry.value && targetStream.calls == 1 && pointerStream.calls == 2);
        [pointerStream finish:nil]; assert([retry.value[@"data"][@"released"] boolValue]);
    } else {
        assert([a.value[@"data"][@"targetStop"][@"nativeCode"] intValue] == -3808);
        if (!delegateFirst) assert([a.value[@"data"][@"pointerStop"][@"nativeCode"] intValue] == -3808);
    }
    assert(!Shares[owner.key] && !PreviewSources[owner.key]);
    assert([Release().value[@"data"][@"released"] boolValue]);
    assert([Preview(PreviewSources[owner.key], @{})[@"state"] isEqual:@"inactive"]);
}
static void FrameAndSemanticBoundaries(void) {
    NSDictionary *binding = @{@"sessionId":@"s",@"runId":@"r"};
    ACShare *owner = [ACShare new]; owner.key=@"s\nr"; owner.window=7; owner.generation=12;
    StopRecorder *target=[StopRecorder new]; owner.stream=(id)target; owner.phase=@"active";
    Shares=[@{owner.key:owner} mutableCopy]; PreviewSources=[Shares mutableCopy];
    owner.toolFrame=@{@"displayTime":@75}; owner.latestFrame=@{@"sequence":@8};
    NSDictionary *request=@{@"windowId":@7,@"generation":@12,@"afterDisplayTime":@75};
    ACReply *reply=[ACReply new]; ReadToolFrame(owner,request,reply,0);
    assert([reply.value[@"ok"] isEqual:@NO] && [reply.value[@"error"] containsString:@"newer"]);
    assert(!CurrentFrameTarget(owner,@{@"windowId":@8,@"generation":@12}));
    assert(!CurrentFrameTarget(owner,@{@"windowId":@7,@"generation":@13}));
    NSDictionary *enter=@{@"operation":@"enterAX",@"binding":binding};
    owner.selectedByUser=YES; reply=[ACReply new]; HandleRequest(enter,reply);
    assert([reply.value[@"ok"] isEqual:@NO] && target.calls==0);
    owner.selectedByUser=NO; reply=[ACReply new]; HandleRequest(enter,reply);
    assert(!reply.value && !owner.toolFrame && !owner.latestFrame && target.calls==1);
    [target finish:nil]; assert([reply.value[@"data"][@"released"] boolValue] && !Shares[owner.key]);
    reply=[ACReply new]; HandleRequest(enter,reply); assert([reply.value[@"ok"] boolValue]);
    assert([CaptureCounts()[@"targetStreamStarts"] isEqual:@0] && [CaptureCounts()[@"pngWrites"] isEqual:@0]);
}
// A real sample and two render requests; fail only the thumbnail, after producing a
// full CGImage. No WindowServer stream, screen pixels or GPU failure is required.
@interface FrameRenderer : NSObject
@property NSUInteger calls;
@property BOOL failThumbnail;
@property(copy) dispatch_block_t onThumbnail;
@end
@implementation FrameRenderer
- (CGImageRef)createCGImage:(CIImage *)image fromRect:(CGRect)rect CF_RETURNS_RETAINED {
    if (++_calls % 2 == 0) {
        if (_onThumbnail) _onThumbnail();
        if (_failThumbnail) return NULL;
    }
    CGColorSpaceRef rgb = CGColorSpaceCreateDeviceRGB();
    CGContextRef canvas = CGBitmapContextCreate(NULL, rect.size.width, rect.size.height, 8, 0, rgb, (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(rgb); assert(canvas);
    CGImageRef result = CGBitmapContextCreateImage(canvas); CGContextRelease(canvas);
    assert(result); return result;
}
@end
@interface FrameFilter : NSObject
@end
@implementation FrameFilter
- (CGRect)contentRect { return CGRectMake(0, 0, 800, 400); }
@end
static void DeliverFrame(ACShare *share, SCStream *stream, uint64_t tick) {
    CVPixelBufferRef pixels = NULL;
    assert(CVPixelBufferCreate(NULL, 800, 400, kCVPixelFormatType_32BGRA, NULL, &pixels) == kCVReturnSuccess);
    CMVideoFormatDescriptionRef format = NULL;
    assert(CMVideoFormatDescriptionCreateForImageBuffer(NULL, pixels, &format) == noErr);
    CMSampleTimingInfo timing = {kCMTimeInvalid, kCMTimeZero, kCMTimeInvalid};
    CMSampleBufferRef sample = NULL;
    assert(CMSampleBufferCreateReadyWithImageBuffer(NULL, pixels, format, &timing, &sample) == noErr);
    NSMutableDictionary *info = [(__bridge NSArray *)CMSampleBufferGetSampleAttachmentsArray(sample, true) firstObject];
    info[SCStreamFrameInfoStatus] = @(SCFrameStatusComplete);
    info[SCStreamFrameInfoDisplayTime] = @(tick);
    info[SCStreamFrameInfoScaleFactor] = @1;
    info[SCStreamFrameInfoContentRect] = CFBridgingRelease(CGRectCreateDictionaryRepresentation(CGRectMake(0, 0, 800, 400)));
    [share stream:stream didOutputSampleBuffer:sample ofType:SCStreamOutputTypeScreen];
    CFRelease(sample); CFRelease(format); CVPixelBufferRelease(pixels);
}
static void ThumbnailFailureKeepsToolFrame(void) {
    ACShare *owner = [ACShare new]; owner.key = @"s\nr"; owner.window = 7; owner.generation = 12;
    owner.filter = (id)[FrameFilter new]; owner.stream = (id)[StopRecorder new]; owner.phase = @"active";
    FrameRenderer *renderer = [FrameRenderer new]; owner.imageContext = (id)renderer;
    Shares = [@{owner.key:owner} mutableCopy]; PreviewSources = [Shares mutableCopy];
    uint64_t tick = mach_absolute_time();
    DeliverFrame(owner, owner.stream, tick - 2);
    assert([Preview(owner, @{})[@"frame"][@"width"] integerValue] == 720);
    renderer.failThumbnail = YES; owner.notBefore = tick - 1;
    DeliverFrame(owner, owner.stream, tick);
    NSDictionary *preview = Preview(owner, @{}), *accepted = owner.toolFrame;
    assert(!preview[@"frame"] && [preview[@"frameError"] containsString:@"preview could not be created"]);
    assert([accepted[@"displayTime"] unsignedLongLongValue] == tick);
    NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSUUID.UUID.UUIDString stringByAppendingPathExtension:@"png"]];
    NSDictionary *request = @{@"windowId":@7, @"generation":@12, @"afterDisplayTime":@(tick-1),
        @"windowWidth":@800, @"windowHeight":@400, @"path":path};
    ACReply *reply = [ACReply new]; ReadToolFrame(owner, request, reply, 0);
    assert([reply.value[@"ok"] boolValue] && [reply.value[@"data"][@"sequence"] isEqual:accepted[@"sequence"]]);
    NSBitmapImageRep *png = [[NSBitmapImageRep alloc] initWithData:[NSData dataWithContentsOfFile:path]];
    assert(png.pixelsWide == 800 && png.pixelsHigh == 400);
    assert([NSFileManager.defaultManager removeItemAtPath:path error:nil]);

    renderer.failThumbnail = NO;
    DeliverFrame(owner, (id)[StopRecorder new], tick + 1);
    DeliverFrame(owner, owner.stream, owner.notBefore);
    renderer.onThumbnail = ^{ owner.generation++; };
    DeliverFrame(owner, owner.stream, tick + 1); renderer.onThumbnail = nil;
    assert(owner.toolFrame == accepted && [Preview(owner, @{}) isEqual:preview]);
    DeliverFrame(owner, owner.stream, tick + 2);
    preview = Preview(owner, @{});
    assert(!preview[@"frameError"] && [preview[@"frame"][@"sequence"] isEqual:owner.toolFrame[@"sequence"]]);
    owner.phase = @"stopped"; DeliverFrame(owner, owner.stream, tick + 3);
    assert(!owner.toolFrame && !owner.latestFrame);
    puts("[macOS Computer Use] PASS: thumbnail failure preserves a readable full-size post-barrier frame; stale samples cannot publish");
}
int main(void) { @autoreleasepool {
    // Do not display the system picker during deterministic callback tests.
    Method m = class_getInstanceMethod(SCContentSharingPicker.class, @selector(setActive:));
    assert(m); method_setImplementation(m, imp_implementationWithBlock(^(id picker, BOOL active) {}));
    NSError *already = [NSError errorWithDomain:SCStreamErrorDomain code:-3808 userInfo:nil];
    FrameAndSemanticBoundaries();
    ThumbnailFailureKeepsToolFrame();
    Scenario(NO, already, NO); Scenario(YES, nil, NO);
    Scenario(NO, [NSError errorWithDomain:@"OtherDomain" code:-3808 userInfo:nil], YES);
    Scenario(NO, [NSError errorWithDomain:SCStreamErrorDomain code:-3801 userInfo:nil], YES);
    puts("[macOS Computer Use] PASS: concurrent target/pointer stop, OS-first stop, scoped -3808, real errors, idempotent release/preview");
} return 0; }
