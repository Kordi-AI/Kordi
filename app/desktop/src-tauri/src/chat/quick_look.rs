//! Quick Look for artifacts: thumbnails from the system generator Finder uses, and the system
//! preview panel for formats the app does not draw itself (Office, Keynote, audio, video).

use std::path::Path;

/// Longest side, in points, of a card thumbnail; rendered at 2x for Retina screens.
pub(crate) const THUMBNAIL_SIDE_POINTS: f64 = 320.0;

#[cfg(target_os = "macos")]
mod macos {
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{
        define_class, msg_send, AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
    };
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{
        NSDictionary, NSError, NSInteger, NSObject, NSObjectProtocol, NSString, NSURL,
    };
    use objc2_quick_look_thumbnailing::{
        QLThumbnailGenerationRequest, QLThumbnailGenerationRequestRepresentationTypes,
        QLThumbnailGenerator, QLThumbnailRepresentation,
    };
    use objc2_quick_look_ui::{QLPreviewItem, QLPreviewPanel, QLPreviewPanelDataSource};

    const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(10);

    fn file_url(path: &Path) -> Retained<NSURL> {
        NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
    }

    fn png_from(representation: &QLThumbnailRepresentation) -> Result<Vec<u8>, String> {
        // Called on Quick Look's own queue; bitmap image reps are safe off the main thread.
        let image = unsafe { representation.CGImage() };
        let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &image);
        let data = unsafe {
            bitmap.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }
        .ok_or_else(|| "The thumbnail could not be encoded.".to_string())?;
        Ok(data.to_vec())
    }

    /// A PNG thumbnail of the file, at most `side_points` on its longest side at 2x scale. Blocks
    /// until Quick Look answers, so call it off the async runtime's worker threads.
    pub(crate) fn thumbnail_png(path: &Path, side_points: f64) -> Result<Vec<u8>, String> {
        let (sender, receiver) = mpsc::channel::<Result<Vec<u8>, String>>();
        let url = file_url(path);
        let request = unsafe {
            QLThumbnailGenerationRequest::initWithFileAtURL_size_scale_representationTypes(
                QLThumbnailGenerationRequest::alloc(),
                &url,
                CGSize {
                    width: side_points,
                    height: side_points,
                },
                2.0,
                QLThumbnailGenerationRequestRepresentationTypes::Thumbnail,
            )
        };
        let completion = RcBlock::new(
            move |representation: *mut QLThumbnailRepresentation, error: *mut NSError| {
                // Quick Look passes either a representation or an error, both owned by it.
                let result = match unsafe { representation.as_ref() } {
                    Some(representation) => png_from(representation),
                    None => Err(unsafe { error.as_ref() }
                        .map(|error| error.localizedDescription().to_string())
                        .unwrap_or_else(|| "No thumbnail for this file.".to_string())),
                };
                let _ = sender.send(result);
            },
        );
        let generator = unsafe { QLThumbnailGenerator::sharedGenerator() };
        unsafe {
            generator.generateBestRepresentationForRequest_completionHandler(&request, &completion)
        };
        match receiver.recv_timeout(THUMBNAIL_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                unsafe { generator.cancelRequest(&request) };
                Err("Quick Look took too long to draw a thumbnail.".to_string())
            }
        }
    }

    define_class!(
        /// Feeds the shared Quick Look panel the one file it should show.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = RefCell<Option<Retained<NSURL>>>]
        struct ArtifactQuickLookSource;

        unsafe impl NSObjectProtocol for ArtifactQuickLookSource {}

        unsafe impl QLPreviewPanelDataSource for ArtifactQuickLookSource {
            #[unsafe(method(numberOfPreviewItemsInPreviewPanel:))]
            fn item_count(&self, _panel: Option<&QLPreviewPanel>) -> NSInteger {
                NSInteger::from(self.ivars().borrow().is_some())
            }

            #[unsafe(method_id(previewPanel:previewItemAtIndex:))]
            fn item_at(
                &self,
                _panel: Option<&QLPreviewPanel>,
                _index: NSInteger,
            ) -> Option<Retained<ProtocolObject<dyn QLPreviewItem>>> {
                self.ivars()
                    .borrow()
                    .as_ref()
                    .map(|url| ProtocolObject::from_retained(url.clone()))
            }
        }
    );

    impl ArtifactQuickLookSource {
        fn new(mtm: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(RefCell::new(None));
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        // The panel keeps only a weak reference to its data source, so the main thread owns it.
        static SOURCE: RefCell<Option<Retained<ArtifactQuickLookSource>>> = const { RefCell::new(None) };
    }

    /// Shows the file in the shared Quick Look panel. Must run on the main thread.
    pub(crate) fn show_quick_look(path: &Path) -> Result<(), String> {
        let mtm = MainThreadMarker::new()
            .ok_or_else(|| "Quick Look must open on the main thread.".to_string())?;
        let source = SOURCE.with(|cell| {
            cell.borrow_mut()
                .get_or_insert_with(|| ArtifactQuickLookSource::new(mtm))
                .clone()
        });
        *source.ivars().borrow_mut() = Some(file_url(path));
        let panel = unsafe { QLPreviewPanel::sharedPreviewPanel(mtm) }
            .ok_or_else(|| "Quick Look is unavailable.".to_string())?;
        unsafe {
            panel.setDataSource(Some(ProtocolObject::from_ref(&*source)));
            panel.reloadData();
        }
        panel.makeKeyAndOrderFront(None);
        Ok(())
    }
}

/// A PNG thumbnail of the file from Quick Look.
pub(crate) fn thumbnail_png(path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    {
        macos::thumbnail_png(path, THUMBNAIL_SIDE_POINTS)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Thumbnails need macOS Quick Look.".to_string())
    }
}

/// Shows the file in the system Quick Look panel. Must run on the main thread.
pub(crate) fn show_quick_look(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::show_quick_look(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Quick Look needs macOS.".to_string())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs the macOS Quick Look service, which CI machines may not run"]
    fn quick_look_draws_a_png_thumbnail() {
        let directory = std::env::temp_dir().join(format!("kordi-ql-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("notes.txt");
        std::fs::write(&path, "Launch brief\n\nShip on Friday.\n").unwrap();
        let png = thumbnail_png(&path).expect("a thumbnail");
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        std::fs::remove_dir_all(directory).ok();
    }
}
