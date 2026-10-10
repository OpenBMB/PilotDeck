#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>

// LaunchServices gives this tiny GUI host its own TCC responsibility. The
// embedded Driver remains its direct child and inherits that responsibility.
// No automation API or daemon listener is implemented by this host.
static NSString *argument(NSArray<NSString *> *args, NSString *flag) {
  NSUInteger index = [args indexOfObject:flag];
  return index != NSNotFound && index + 1 < args.count ? args[index + 1] : nil;
}

static NSDictionary *driverEnvironment(void) {
  NSSet *allowed = [NSSet setWithArray:@[@"PATH", @"HOME", @"USER", @"LOGNAME", @"SHELL", @"TMPDIR", @"LANG"]];
  NSMutableDictionary *env = [NSMutableDictionary dictionary];
  [NSProcessInfo.processInfo.environment enumerateKeysAndObjectsUsingBlock:^(NSString *key, NSString *value, BOOL *stop) {
    if ([allowed containsObject:key] || [key hasPrefix:@"LC_"]) env[key] = value;
  }];
  env[@"CUA_DRIVER_EMBEDDED"] = @"1";
  env[@"CUA_DRIVER_HOST_BUNDLE_ID"] = NSBundle.mainBundle.bundleIdentifier;
  env[@"CUA_DRIVER_RS_TELEMETRY_ENABLED"] = @"false";
  env[@"CUA_TELEMETRY_ENABLED"] = @"false";
  return env;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    [NSApp finishLaunching];
    NSArray<NSString *> *args = NSProcessInfo.processInfo.arguments;
    if ([args containsObject:@"permissions"]) {
      NSString *permission = argument(args, @"--permission");
      NSString *resultFile = argument(args, @"--result-file");
      if (!resultFile.isAbsolutePath || ![resultFile.lastPathComponent hasPrefix:@"pilotdeck-permissions-"]) return 64;
      if (![@[@"accessibility", @"screenRecording"] containsObject:permission]) return 64;
      // Publish startup before requesting consent. The backend must remain
      // responsive while the user handles macOS's prompt or System Settings.
      NSDictionary *result = @{@"accessibility": @(AXIsProcessTrusted()), @"screen_recording": @(CGPreflightScreenCaptureAccess()),
        @"host_bundle_id": NSBundle.mainBundle.bundleIdentifier};
      NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
      int fd = open(resultFile.fileSystemRepresentation, O_WRONLY | O_TRUNC | O_NOFOLLOW);
      if (fd < 0) return 74;
      ssize_t written = write(fd, data.bytes, data.length); close(fd);
      if (written != (ssize_t)data.length) return 74;
      if ([args containsObject:@"--parent-liveness-stdio"]) {
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
          char bytes[256]; ssize_t received;
          do { received = read(STDIN_FILENO, bytes, sizeof(bytes)); } while (received > 0 || (received < 0 && errno == EINTR));
          exit(0);
        });
      }
      if ([permission isEqualToString:@"accessibility"]) {
        AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)@{(__bridge NSString *)kAXTrustedCheckOptionPrompt: @YES});
      } else if ([permission isEqualToString:@"screenRecording"]) {
        CGRequestScreenCaptureAccess();
        // macOS may require direct ScreenCaptureKit consent after preflight.
        // Only this explicit user permission action performs the live probe.
        [SCShareableContent getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES completionHandler:^(SCShareableContent *content, NSError *error) {
          // A denied probe can finish before the consent dialog is answered.
          // Keep its GUI owner alive so macOS can finish the user's request.
        }];
      }
      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:300];
      [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
        BOOL granted = [permission isEqualToString:@"accessibility"] ? AXIsProcessTrusted() : CGPreflightScreenCaptureAccess();
        if (granted || deadline.timeIntervalSinceNow <= 0) exit(0);
      }];
      [NSApp run];
      return 0;
    }
    NSString *socket = argument(args, @"--socket");
    if (![args containsObject:@"serve"] || !socket.isAbsolutePath) return 64;
    NSTask *driver = [[NSTask alloc] init];
    driver.executableURL = [NSURL fileURLWithPath:[NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS/cua-driver"]];
    driver.arguments = @[@"serve", @"--embedded", @"--socket", socket, @"--host-bundle-id", NSBundle.mainBundle.bundleIdentifier,
      @"--parent-liveness-stdio", @"--no-permissions-gate", @"--permission-mode", @"standard"];
    driver.environment = driverEnvironment();
    // Keep the child's lifetime pipe owned by this GUI host. If either the
    // backend (FIFO writer) or this host exits, the Driver sees stdin EOF.
    NSPipe *lifetime = [NSPipe pipe];
    driver.standardInput = lifetime.fileHandleForReading;
    driver.standardOutput = NSFileHandle.fileHandleWithStandardOutput;
    driver.standardError = NSFileHandle.fileHandleWithStandardError;
    driver.terminationHandler = ^(NSTask *task) {
      dispatch_async(dispatch_get_main_queue(), ^{ exit(task.terminationStatus); });
    };
    NSError *error = nil;
    if (![driver launchAndReturnError:&error]) { fprintf(stderr, "%s\n", error.localizedDescription.UTF8String); return 70; }
    [lifetime.fileHandleForReading closeFile];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      char bytes[256]; ssize_t received;
      do { received = read(STDIN_FILENO, bytes, sizeof(bytes)); } while (received > 0 || (received < 0 && errno == EINTR));
      [lifetime.fileHandleForWriting closeFile];
    });
    [NSApp run];
    return 0;
  }
}
