// One non-activating AppKit fixture. No global input or desktop permissions are needed by this app.
#import <AppKit/AppKit.h>
#import <unistd.h>

static NSString *root;
static NSArray *unbacked;
static NSInteger presses, grayPresses;
@interface QAMarker : NSView
@property BOOL changed;
@end
@implementation QAMarker
- (void)drawRect:(NSRect)r {
    [(self.changed ? NSColor.greenColor : NSColor.redColor) setFill]; NSRectFill(self.bounds);
}
@end
static QAMarker *marker;
static void Save(NSString *name, NSDictionary *value) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
    if (![json writeToFile:[root stringByAppendingPathComponent:name] atomically:YES]) abort();
}
static BOOL Broken(void) {
    return [[NSFileManager defaultManager] fileExistsAtPath:[root stringByAppendingPathComponent:@"unbacked-windows"]];
}
// Use AppKit's ordinary AX window representation until the controlled negative case.
@interface QAWindow : NSWindow
@property(copy) NSArray *orderedControls;
@end
@implementation QAWindow
- (NSArray *)accessibilityChildren { return self.orderedControls ?: [super accessibilityChildren]; }
@end
@interface GrayButton : NSButton
@end
@implementation GrayButton
// Deliberately expose the press capability while the real NSControl remains disabled.
- (BOOL)isAccessibilitySelectorAllowed:(SEL)sel {
    return sel == @selector(accessibilityPerformPress) || [super isAccessibilitySelectorAllowed:sel];
}
- (NSArray *)accessibilityActionNames { return @[NSAccessibilityPressAction]; }
@end
@interface Counter : NSObject
- (void)pressed:(id)sender;
@end
@implementation Counter
- (void)pressed:(NSButton *)sender {
    if (sender.enabled) ++presses; else ++grayPresses;
    // The synchronous button effect is the green marker. AX dispatch is not
    // a promise about an unrelated animation scheduled to start 350ms later.
    marker.changed = YES; [marker setNeedsDisplay:YES];
    [marker displayIfNeeded];
    Save(@"effects.json", @{@"enabled":@(presses), @"disabled":@(grayPresses)});
}
@end
int main(int argc, const char **argv) {
    @autoreleasepool {
        if (argc == 3 && strcmp(argv[1], "--marker") == 0) {
            NSBitmapImageRep *png = [NSBitmapImageRep imageRepWithData:[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]]];
            if (!png) return 2;
            size_t width = CGImageGetWidth(png.CGImage), height = CGImageGetHeight(png.CGImage);
            CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
            CGContextRef ctx = CGBitmapContextCreate(NULL,width,height,8,width*4,space,kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big);
            CGColorSpaceRelease(space);
            if (!ctx) return 2;
            CGContextDrawImage(ctx,CGRectMake(0,0,width,height),png.CGImage);
            const uint8_t *bytes = CGBitmapContextGetData(ctx);
            int red = 0, green = 0;
            for (size_t y=0; y<height; y+=8) for (size_t x=0; x<width; x+=8) {
                const uint8_t *p = bytes + (y*width+x)*4;
                if (p[0] > 2*p[1] && p[0] > 2*p[2] && p[0]>150) red++;
                if (p[1] > 2*p[0] && p[1] > 2*p[2] && p[1]>150) green++;
            }
            CGContextRelease(ctx);
            printf("{\"red\":%d,\"green\":%d}\n", red, green);
            return 0;
        }
        if (argc != 2) return 2;
        root = [NSString stringWithUTF8String:argv[1]];
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
        QAWindow *w = [[QAWindow alloc] initWithContentRect:NSMakeRect(100, 100, 660, 450)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        w.title = @"Achbit QA • native observation";
        __attribute__((objc_precise_lifetime)) Counter *counter = [Counter new];
        NSMutableArray *controls = [NSMutableArray new];
        NSButton *liveButton = nil;
        NSString *label = [@"" stringByPaddingToLength:1024 withString:@"gray-" startingAtIndex:0];
        for (NSUInteger i = 0; i <= 110; i++) {
            BOOL enabled = i == 110;
            NSButton *b = [[enabled ? NSButton.class : GrayButton.class alloc]
                initWithFrame:NSMakeRect(4+(i%10)*65, 8+(i/10)*35, enabled ? 160 : 61, 27)];
            b.title = enabled ? @"Verify retained control" : [NSString stringWithFormat:@"Gray-%03lu-%@-END", (unsigned long)i, label];
            b.enabled = enabled; b.target = counter; b.action = @selector(pressed:);
            if (enabled) liveButton = b;
            [w.contentView addSubview:b]; [controls addObject:b];
        }
        marker = [[QAMarker alloc] initWithFrame:NSMakeRect(305,402,100,40)]; [w.contentView addSubview:marker];
        NSTextField *field = [NSTextField textFieldWithString:@"Before"];
        field.frame = NSMakeRect(435,405,120,26); [field setAccessibilityLabel:@"Verify writable field"];
        [w.contentView addSubview:field]; [controls addObject:field];
        w.orderedControls = controls;
        // Same title, distinct WindowServer and AX identity. Never activate either window.
        NSWindow *other = [[NSWindow alloc] initWithContentRect:NSMakeRect(105,105,240,110) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        other.title = w.title; [other orderBack:nil];
        NSMutableArray *virtualWindows = [NSMutableArray new];
        for (NSUInteger i=0; i<300; ++i) {
            NSAccessibilityElement *e = [NSAccessibilityElement accessibilityElementWithRole:NSAccessibilityWindowRole
                frame:NSZeroRect label:@"Virtual QA window" parent:app];
            [virtualWindows addObject:e];
        }
        unbacked = virtualWindows;
        [app finishLaunching];
        [w orderFrontRegardless];
        Save(@"target.json", @{@"windowId":@(w.windowNumber), @"pid":@(getpid()), @"app":NSBundle.mainBundle.bundleIdentifier, @"siblingId":@(other.windowNumber)});
        Save(@"effects.json", @{@"enabled":@0, @"disabled":@0});
        __block NSPanel *cover = nil;
        [NSTimer scheduledTimerWithTimeInterval:0.15 repeats:YES block:^(NSTimer *timer) {
            NSFileManager *fs = NSFileManager.defaultManager;
            // Same front panel and point, two different mouse destinations. Do
            // not infer the destination from either the AX tree or a rectangle.
            if ([fs fileExistsAtPath:[root stringByAppendingPathComponent:@"pass-point"]] && ![fs fileExistsAtPath:[root stringByAppendingPathComponent:@"uncover-point"]]) {
                NSPoint center = NSMakePoint(NSMidX(liveButton.bounds), NSMidY(liveButton.bounds));
                NSPoint p = [w convertPointToScreen:[liveButton convertPoint:center toView:nil]];
                if (!cover) {
                    cover = [[NSPanel alloc] initWithContentRect:NSMakeRect(p.x-55,p.y-20,110,40) styleMask:NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];
                    cover.hidesOnDeactivate = NO; cover.level = NSFloatingWindowLevel;
                    cover.opaque = NO; cover.backgroundColor = [NSColor.blueColor colorWithAlphaComponent:0.12];
                    cover.ignoresMouseEvents = YES; [cover orderFrontRegardless];
                }
                BOOL intercept = [fs fileExistsAtPath:[root stringByAppendingPathComponent:@"cover-point"]];
                if (intercept && cover.ignoresMouseEvents) { cover.ignoresMouseEvents = NO; cover.backgroundColor = NSColor.blueColor; }
                NSInteger hit = [NSWindow windowNumberAtPoint:p belowWindowWithWindowNumber:0];
                NSString *ack = intercept ? @"cover-ready.json" : @"pass-ready.json";
                if (![fs fileExistsAtPath:[root stringByAppendingPathComponent:ack]]) {
                    NSDictionary *probe = @{@"panel": @(cover.windowNumber), @"pointInPanel": @(NSPointInRect(p, cover.frame)),
                        @"ignoresMouse": @(cover.ignoresMouseEvents), @"hit": hit == w.windowNumber ? @"target" : hit == cover.windowNumber ? @"panel" : @"other"};
                    Save(@"fixture-hit.json", probe);
                    if (hit == (intercept ? cover.windowNumber : w.windowNumber)) Save(ack, probe);
                }
            }
            if (cover && [fs fileExistsAtPath:[root stringByAppendingPathComponent:@"uncover-point"]]) {
                [cover orderOut:nil]; cover=nil; Save(@"uncovered.json",@{@"ready":@YES});
            }
            if ([fs fileExistsAtPath:[root stringByAppendingPathComponent:@"move-window"]] && ![fs fileExistsAtPath:[root stringByAppendingPathComponent:@"moved.json"]]) {
                [w setFrameOrigin:NSMakePoint(w.frame.origin.x+18,w.frame.origin.y+8)]; Save(@"moved.json",@{@"ready":@YES});
            }
            if ([field.stringValue isEqual:@"After"]) Save(@"value.json", @{@"actual":field.stringValue});
            if (Broken() && unbacked) {
                [app setAccessibilityWindows:unbacked]; unbacked = nil;
                Save(@"unbacked-ready.json", @{@"ready":@YES});
            }
            if ([[NSFileManager defaultManager] fileExistsAtPath:[root stringByAppendingPathComponent:@"stop-window"]]) {
                [timer invalidate]; [app terminate:nil];
            }
        }];
        [app run];
    }
    return 0;
}
