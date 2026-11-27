// Included in sharing.m after ACShare. Tool images come from the complete native
// surface, never the JPEG thumbnail. All admission and commits run on the main queue.
static BOOL CurrentFrameTarget(ACShare *share, NSDictionary *request) {
    return share && Shares[share.key] == share && [share.phase isEqual:@"active"] &&
        share.window == [request[@"windowId"] unsignedIntValue] &&
        share.generation == [request[@"generation"] unsignedLongLongValue];
}
static void ReadToolFrame(ACShare *share, NSDictionary *request, ACReply *reply, NSTimeInterval deadline) {
    if (!reply.pending) return;
    if (!CurrentFrameTarget(share, request)) { [reply finish:Failure(@"Target sharing stopped or changed; no tool frame")]; return; }
    NSDictionary *frame;
    @synchronized (share) { frame = share.toolFrame; }
    NSNumber *barrier = request[@"afterDisplayTime"];
    mach_timebase_info_data_t clockScale; mach_timebase_info(&clockScale);
    uint64_t tick = [frame[@"displayTime"] unsignedLongLongValue], now = mach_absolute_time();
    double ageMs = tick && tick <= now ? (double)(now - tick) * clockScale.numer / clockScale.denom / 1e6 : INFINITY;
    uint64_t after = [barrier isKindOfClass:NSNumber.class] ? barrier.unsignedLongLongValue : 0;
    if (!frame || tick <= after || ageMs > 120000.) {
        if (NSProcessInfo.processInfo.systemUptime >= deadline) {
            [reply finish:Failure(@"No complete target frame newer than the observation barrier; no image returned")]; return;
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 35*NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
            ReadToolFrame(share, request, reply, deadline);
        }); return;
    }
    CGSize logical = share.filter.contentRect.size;
    if (logical.width != [request[@"windowWidth"] doubleValue] || logical.height != [request[@"windowHeight"] doubleValue]) {
        [reply finish:Failure(@"Capture and WindowServer extents disagree; observe the exact window again")]; return;
    }
    CGImageRef source = (__bridge CGImageRef)frame[@"bitmap"];
    CGRect surface = CGRectMake(0, 0, CGImageGetWidth(source), CGImageGetHeight(source));
    CGRect points; double scale = [frame[@"scaleFactor"] doubleValue];
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)frame[@"contentRect"], &points) ||
        !isfinite(scale) || scale <= 0 || CGRectIsEmpty(points)) {
        [reply finish:Failure(@"Complete frame did not report valid content geometry")]; return;
    }
    // Strip any native padding. ContentRect is in surface points, not global
    // screen coordinates. The resulting PNG origin is the whole window's top left.
    CGRect content = CGRectApplyAffineTransform(points, CGAffineTransformMakeScale(scale,scale));
    content = CGRectMake(round(content.origin.x), round(content.origin.y), round(content.size.width), round(content.size.height));
    if (!CGRectContainsRect(surface, content) || CGRectIsEmpty(content) ||
        fabs(content.size.height - content.size.width * logical.height / logical.width) > 2.0) {
        [reply finish:Failure([NSString stringWithFormat:@"Unverified frame geometry: content=%@, scale=%g, surface=%@, window=%@", NSStringFromRect(points), scale, NSStringFromRect(surface), NSStringFromSize(logical)])]; return;
    }
    CGImageRef cropped = CGImageCreateWithImageInRect(source, content);
    if (!cropped) { [reply finish:Failure(@"Tool frame cropping failed")]; return; }
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:cropped];
    CGImageRelease(cropped);
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png) { [reply finish:Failure(@"Tool frame PNG encoding failed")]; return; }
    NSError *error = nil;
    if (![png writeToFile:request[@"path"] options:NSDataWritingAtomic error:&error]) { [reply finish:NativeFailure(@"writePNG",error)]; return; }
    atomic_fetch_add(&PNGWrites,1);
    [reply finish:Success(@{@"width":@(bitmap.pixelsWide), @"height":@(bitmap.pixelsHigh), @"sequence":frame[@"sequence"],
        @"displayTime":frame[@"displayTime"], @"ageMillis":@((uint64_t)ceil(ageMs)),
        @"capturedAt":[NSString stringWithFormat:@"%.0f",NSDate.date.timeIntervalSince1970*1000.-ageMs], @"contentRect":frame[@"contentRect"], @"scaleFactor":frame[@"scaleFactor"],
        @"contentScale":frame[@"contentScale"], @"surfaceCropPixels":@{@"x":@(content.origin.x),@"y":@(content.origin.y),@"width":@(content.size.width),@"height":@(content.size.height)}})];
}
