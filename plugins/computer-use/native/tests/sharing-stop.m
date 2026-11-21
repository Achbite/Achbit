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
int main(void) { @autoreleasepool {
    // Do not display the system picker during deterministic callback tests.
    Method m = class_getInstanceMethod(SCContentSharingPicker.class, @selector(setActive:));
    assert(m); method_setImplementation(m, imp_implementationWithBlock(^(id picker, BOOL active) {}));
    NSError *already = [NSError errorWithDomain:SCStreamErrorDomain code:-3808 userInfo:nil];
    Scenario(NO, already, NO); Scenario(YES, nil, NO);
    Scenario(NO, [NSError errorWithDomain:@"OtherDomain" code:-3808 userInfo:nil], YES);
    Scenario(NO, [NSError errorWithDomain:SCStreamErrorDomain code:-3801 userInfo:nil], YES);
    puts("[macOS Computer Use] PASS: concurrent target/pointer stop, OS-first stop, scoped -3808, real errors, idempotent release/preview");
} return 0; }
