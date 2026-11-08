#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cmath>

// This module is loaded only by the Electron main process. No renderer receives
// a native pointer, and it neither requests system permissions nor captures pixels.
static NSMapTable<NSView *, NSGlassEffectView *> *surfaces;
static bool available() {
  if (@available(macOS 26.0, *)) return NSClassFromString(@"NSGlassEffectView") != nil;
  return false;
}
static bool reduced() { return NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceTransparency || NSWorkspace.sharedWorkspace.accessibilityDisplayShouldIncreaseContrast; }
static napi_value boolean(napi_env env, bool value) { napi_value result; napi_get_boolean(env, value, &result); return result; }
static NSView *viewArgument(napi_env env, napi_value arg) {
  bool buffer = false; napi_is_buffer(env, arg, &buffer);
  if (!buffer) return nil;
  void *bytes = nullptr; size_t length = 0; napi_get_buffer_info(env, arg, &bytes, &length);
  if (length != sizeof(void *)) return nil;
  return (__bridge NSView *)(*reinterpret_cast<void **>(bytes));
}
static napi_value status(napi_env env, napi_callback_info info) {
  napi_value result; napi_create_object(env, &result);
  napi_set_named_property(env, result, "supported", boolean(env, available()));
  napi_set_named_property(env, result, "reduced", boolean(env, reduced()));
  return result;
}
static napi_value update(napi_env env, napi_callback_info info) {
  size_t count = 4; napi_value args[4]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 4 || !NSThread.isMainThread) return boolean(env, false);
  NSView *native = viewArgument(env, args[0]); if (!native || !native.window) return boolean(env, false);
  bool enabled = false; napi_get_value_bool(env, args[2], &enabled);
  if (!surfaces) surfaces = [NSMapTable weakToStrongObjectsMapTable];
  NSGlassEffectView *glass = [surfaces objectForKey:native];
  if (!enabled || !available() || reduced()) {
    [glass removeFromSuperview]; [surfaces removeObjectForKey:native];
    native.window.opaque = YES; native.window.backgroundColor = NSColor.windowBackgroundColor;
    return boolean(env, false);
  }
  double width = 0; napi_get_value_double(env, args[1], &width);
  if (!std::isfinite(width) || width < 1) { [glass removeFromSuperview]; [surfaces removeObjectForKey:native]; native.window.opaque = YES; native.window.backgroundColor = NSColor.windowBackgroundColor; return boolean(env, false); }
  if (@available(macOS 26.0, *)) {
    NSView *host = native.window.contentView;
    if (!glass) {
      glass = [[NSClassFromString(@"NSGlassEffectView") alloc] initWithFrame:NSZeroRect];
      glass.style = NSGlassEffectViewStyleRegular;
      glass.cornerRadius = 14;
      glass.autoresizingMask = NSViewHeightSizable;
      [host addSubview:glass positioned:NSWindowBelow relativeTo:host.subviews.firstObject];
      [surfaces setObject:glass forKey:native];
    }
    bool dark = false; napi_get_value_bool(env, args[3], &dark);
    glass.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    glass.frame = NSMakeRect(0, 0, MIN(width, host.bounds.size.width), host.bounds.size.height);
    native.window.opaque = NO;
    native.window.backgroundColor = NSColor.clearColor;
    return boolean(env, true);
  }
  return boolean(env, false);
}
// Main-process diagnostics for this application's own view; never captures pixels.
static napi_value inspect(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1]; napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_value result; napi_create_object(env, &result);
  if (count != 1 || !NSThread.isMainThread) return result;
  NSView *native = viewArgument(env, args[0]);
  NSView *glass = native ? [surfaces objectForKey:native] : nil;
  napi_set_named_property(env, result, "windowOpaque", boolean(env, native.window.opaque));
  napi_set_named_property(env, result, "exists", boolean(env, glass != nil));
  if (glass) {
    napi_value value;
    napi_create_string_utf8(env, NSStringFromClass(glass.class).UTF8String, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "viewClass", value);
    napi_create_string_utf8(env, glass.effectiveAppearance.name.UTF8String, NAPI_AUTO_LENGTH, &value); napi_set_named_property(env, result, "appearance", value);
    napi_create_double(env, glass.frame.size.width, &value); napi_set_named_property(env, result, "width", value);
    napi_create_double(env, glass.frame.size.height, &value); napi_set_named_property(env, result, "height", value);
  }
  return result;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {{"status", nullptr, status, nullptr, nullptr, nullptr, napi_default, nullptr}, {"update", nullptr, update, nullptr, nullptr, nullptr, napi_default, nullptr}, {"inspect", nullptr, inspect, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 3, properties); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
