// Copyright 2020-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::path::PathBuf;

use objc2::{
  runtime::{AnyObject, Bool, ProtocolObject},
  ClassType, DeclaredClass,
};
use objc2_app_kit::{NSDragOperation, NSDraggingInfo, NSPasteboardURLReadingFileURLsOnlyKey};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSPoint, NSRect, NSURL};

use crate::DragDropEvent;

use super::WryWebView;

pub(crate) unsafe fn collect_paths(drag_info: &ProtocolObject<dyn NSDraggingInfo>) -> Vec<PathBuf> {
  let pb = drag_info.draggingPasteboard();
  let mut drag_drop_paths = Vec::new();
  let classes = NSArray::from_slice(&[NSURL::class()]);
  let options = NSDictionary::from_slices(
    &[NSPasteboardURLReadingFileURLsOnlyKey],
    &[&*NSNumber::new_bool(true) as &AnyObject],
  );

  if let Some(urls) = pb.readObjectsForClasses_options(&classes, Some(&options)) {
    for url in urls {
      // The pasteboard returns only objects of the requested NSURL class.
      let url = url.downcast::<NSURL>().unwrap();
      if let Some(path) = url.path() {
        drag_drop_paths.push(PathBuf::from(path.to_string()));
      }
    }
  }
  drag_drop_paths
}

pub(crate) fn dragging_entered(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Enter { paths, position }) {
    // Reject the Wry file drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingEntered: drag_info] }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn dragging_updated(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> NSDragOperation {
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Over { position }) {
    unsafe {
      let os_operation = objc2::msg_send![super(this), draggingUpdated: drag_info];
      if os_operation == NSDragOperation::None {
        // 0 will be returned for a drop on any arbitrary location on the webview.
        // We'll override that with NSDragOperationCopy.
        NSDragOperation::Copy
      } else {
        // A different NSDragOperation is returned when a file is hovered over something like
        // a <input type="file">, so we'll make sure to preserve that behaviour.
        os_operation
      }
    }
  } else {
    NSDragOperation::Copy
  }
}

pub(crate) fn perform_drag_operation(
  this: &WryWebView,
  drag_info: &ProtocolObject<dyn NSDraggingInfo>,
) -> Bool {
  let paths = unsafe { collect_paths(drag_info) };
  let dl: NSPoint = drag_info.draggingLocation();
  let frame: NSRect = this.frame();
  let position = (dl.x as i32, (frame.size.height - dl.y) as i32);

  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Drop { paths, position }) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), performDragOperation: drag_info] }
  } else {
    Bool::YES
  }
}

pub(crate) fn dragging_exited(this: &WryWebView, drag_info: &ProtocolObject<dyn NSDraggingInfo>) {
  let listener = &this.ivars().drag_drop_handler;
  if !listener(DragDropEvent::Leave) {
    // Reject the Wry drop (invoke the OS default behaviour)
    unsafe { objc2::msg_send![super(this), draggingExited: drag_info] }
  }
}
