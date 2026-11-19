//! Prepare only user image attachments. Tool/archival byte limits remain independent.
use achbit_kernel_tools::file_content::{image_type_from_header, MAX_IMAGE_INPUT_BYTES};
use axum::{
    http::header,
    response::{IntoResponse, Response},
};
use bytes::Bytes;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::{
    io::{Cursor, Read},
    path::PathBuf,
};

pub(crate) const MAX_SOURCE_BYTES: usize = 32 * 1024 * 1024;
const MAX_EDGE: u32 = 2048;
const MAX_PIXELS: u64 = 32_000_000;
const MAX_AXIS: u32 = 16384;
const MAX_DECODE_BYTES: u64 = 128 * 1024 * 1024;
static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
type Prepared = (&'static str, Bytes);
const ANIMATED: &str = "Animated images over 8 MiB cannot be reduced without losing frames. Resize the animation first.";
fn decode_error(e: impl std::fmt::Display) -> String {
    format!("Image compression failed: {e}")
}
fn limits() -> Limits {
    let mut l = Limits::default();
    l.max_image_width = Some(MAX_AXIS);
    l.max_image_height = Some(MAX_AXIS);
    l.max_alloc = Some(MAX_DECODE_BYTES);
    l
}
fn bounded_dimensions(w: u32, h: u32, n: u64) -> Result<(), String> {
    if w == 0
        || h == 0
        || w > MAX_AXIS
        || h > MAX_AXIS
        || u64::from(w) * u64::from(h) > MAX_PIXELS
        || n > MAX_DECODE_BYTES
    {
        return Err(
            "Image is too large to decode safely (32 megapixels, 16384 per side, 128 MiB decoded)."
                .into(),
        );
    }
    Ok(())
}
fn reduce(data: &[u8], media: &str) -> Result<Prepared, String> {
    let open = || Cursor::new(data);
    let format = match media {
        "image/png" => {
            let d = image::codecs::png::PngDecoder::with_limits(open(), limits())
                .map_err(decode_error)?;
            if d.is_apng().map_err(decode_error)? {
                return Err(ANIMATED.into());
            }
            ImageFormat::Png
        }
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => {
            let d = image::codecs::webp::WebPDecoder::new(open()).map_err(decode_error)?;
            if d.has_animation() {
                return Err(ANIMATED.into());
            }
            ImageFormat::WebP
        }
        "image/gif" => {
            let mut opt = gif::DecodeOptions::new();
            opt.skip_frame_decoding(true);
            let mut d = opt.read_info(open()).map_err(decode_error)?;
            if d.next_frame_info().map_err(decode_error)?.is_none() {
                return Err("Empty GIF".into());
            }
            if d.next_frame_info().map_err(decode_error)?.is_some() {
                return Err(ANIMATED.into());
            }
            ImageFormat::Gif
        }
        _ => return Err("Unsupported image format".into()),
    };
    let mut reader = ImageReader::with_format(open(), format);
    reader.limits(limits());
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (w, h) = decoder.dimensions();
    bounded_dimensions(w, h, decoder.total_bytes())?;
    let orientation = decoder.orientation().map_err(decode_error)?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    img.apply_orientation(orientation);
    if img.width().max(img.height()) > MAX_EDGE {
        img = img.thumbnail(MAX_EDGE, MAX_EDGE);
    }
    // Do not introduce JPEG artifacts in screenshots or discard transparency. Normalize only oversized sources.
    let (mime, mut img) = if format == ImageFormat::Jpeg {
        ("image/jpeg", DynamicImage::ImageRgb8(img.into_rgb8()))
    } else if img.color().has_alpha() {
        ("image/png", DynamicImage::ImageRgba8(img.into_rgba8()))
    } else {
        ("image/png", DynamicImage::ImageRgb8(img.into_rgb8()))
    };
    loop {
        let mut out = Cursor::new(Vec::new());
        if mime == "image/jpeg" {
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
                .encode_image(&img)
                .map_err(decode_error)?;
        } else {
            img.write_to(&mut out, ImageFormat::Png)
                .map_err(decode_error)?;
        }
        let bytes = out.into_inner();
        if bytes.len() <= MAX_IMAGE_INPUT_BYTES {
            return Ok((mime, bytes.into()));
        }
        let edge = img.width().max(img.height());
        if edge <= 1 {
            return Err("Cannot fit image within 8 MiB".into());
        }
        let edge = (edge * 3 / 4).max(1);
        img = img.thumbnail(edge, edge);
    }
}
pub(crate) async fn prepare(bytes: Bytes, declared: &str) -> Result<Prepared, String> {
    if bytes.len() > MAX_SOURCE_BYTES {
        return Err("Image source exceeds 32 MiB.".into());
    }
    let media =
        image_type_from_header(&bytes).ok_or("Unsupported PNG/JPEG/GIF/WebP image content.")?;
    if declared != media {
        return Err("input_resource_media_type_mismatch".into());
    }
    if bytes.len() <= MAX_IMAGE_INPUT_BYTES {
        return Ok((media, bytes));
    }
    let permit = SLOTS.acquire().await.map_err(decode_error)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        reduce(&bytes, media)
    })
    .await
    .map_err(decode_error)?
}
/// Read a resolved, user-authorized file; retain the source bytes on disk. The cap covers files that grow while reading.
pub(crate) async fn read_source(path: PathBuf) -> Result<Bytes, String> {
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        if len > MAX_SOURCE_BYTES as u64 {
            return Err("Image source exceeds 32 MiB.".into());
        }
        let mut bytes = Vec::with_capacity(len as usize);
        file.take(MAX_SOURCE_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_SOURCE_BYTES {
            return Err("Image source exceeds 32 MiB.".into());
        }
        Ok(bytes.into())
    })
    .await
    .map_err(decode_error)?
}
#[cfg(test)]
mod tests {
    use super::*;
    use image::{GenericImageView, Rgba, RgbaImage};
    fn encoded(img: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut dst = Cursor::new(Vec::new());
        img.write_to(&mut dst, format).unwrap();
        dst.into_inner()
    }
    #[tokio::test]
    async fn inclusive_boundary_and_bad_inputs() {
        let mut b = vec![0; MAX_IMAGE_INPUT_BYTES];
        b[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        let b = Bytes::from(b);
        let keep = prepare(b.clone(), "image/png").await.unwrap();
        assert_eq!(keep.1.as_ptr(), b.as_ptr());
        assert!(prepare(b, "image/jpeg")
            .await
            .unwrap_err()
            .contains("mismatch"));
        let mut invalid = vec![0; MAX_IMAGE_INPUT_BYTES + 1];
        invalid[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        assert!(prepare(invalid.into(), "image/png").await.is_err());
        assert!(prepare(vec![0; MAX_SOURCE_BYTES + 1].into(), "image/png")
            .await
            .unwrap_err()
            .contains("32 MiB"));
    }
    #[test]
    fn static_copy_preserves_shape_and_alpha() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_fn(3072, 1536, |x, _| {
            Rgba([28, 67, 92, if x < 1536 { 0 } else { 255 }])
        }));
        let original = encoded(&source, ImageFormat::Png);
        let (media, out) = reduce(&original, "image/png").unwrap();
        assert_eq!(media, "image/png");
        let output = image::load_from_memory(&out).unwrap();
        assert_eq!(output.dimensions(), (2048, 1024));
        assert_eq!(output.get_pixel(20, 20)[3], 0);
        assert_eq!(output.get_pixel(2000, 20)[3], 255);
        assert!(out.len() <= MAX_IMAGE_INPUT_BYTES);
    }
    #[test]
    fn static_codecs_and_animation_policy() {
        let im = DynamicImage::ImageRgba8(RgbaImage::from_pixel(12, 8, Rgba([22, 88, 144, 255])));
        for (format, media, expected) in [
            (ImageFormat::Jpeg, "image/jpeg", "image/jpeg"),
            (ImageFormat::WebP, "image/webp", "image/png"),
            (ImageFormat::Gif, "image/gif", "image/png"),
        ] {
            let b = encoded(&DynamicImage::ImageRgb8(im.to_rgb8()), format);
            let (actual, out) = reduce(&b, media).unwrap();
            assert_eq!(actual, expected);
            assert_eq!(image::load_from_memory(&out).unwrap().dimensions(), (12, 8));
        }
        let mut gif_bytes = Vec::new();
        {
            let mut enc = image::codecs::gif::GifEncoder::new(&mut gif_bytes);
            enc.encode_frames([
                image::Frame::new(im.to_rgba8()),
                image::Frame::new(im.to_rgba8()),
            ])
            .unwrap();
        }
        assert_eq!(reduce(&gif_bytes, "image/gif").unwrap_err(), ANIMATED);
    }
    #[test]
    fn bounds_apply_before_full_decode() {
        assert!(bounded_dimensions(8000, 5000, 120_000_000).is_err());
        assert!(bounded_dimensions(17000, 1, 68000).is_err());
        assert!(bounded_dimensions(2, 2, MAX_DECODE_BYTES + 1).is_err());
        assert!(bounded_dimensions(4000, 3000, 48_000_000).is_ok());
    }
}

/// Stateless draft preparation: no file path, Session creation, disk write or model call.
pub(crate) async fn draft_preview(headers: axum::http::HeaderMap, bytes: Bytes) -> Response {
    let declared = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match prepare(bytes, declared).await {
        Ok((media, bytes)) => (
            [
                (header::CONTENT_TYPE, media),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Err(e) => crate::ApiResponse::error("attachment_image_prepare_failed", e).into_response(),
    }
}
