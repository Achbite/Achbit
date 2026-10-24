//! Bounded presentation frames; these never enter the model's capture archive.
use image::{codecs::jpeg::JpegEncoder, ImageFormat, ImageReader, Limits};
use std::io::Cursor;

#[cfg(test)]
pub fn jpeg(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    jpeg_region(png, None)
}

pub fn jpeg_region(png: &[u8], region: Option<[f64; 4]>) -> Result<(Vec<u8>, u32, u32), String> {
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    let mut limits = Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let mut image = reader.decode().map_err(|error| error.to_string())?;
    if let Some([x, y, width, height]) = region {
        if ![x, y, width, height].iter().all(|value| value.is_finite())
            || x < 0.0
            || y < 0.0
            || width <= 0.0
            || height <= 0.0
            || x + width > 1.000001
            || y + height > 1.000001
        {
            return Err("native_browser_preview_region_invalid".into());
        }
        let left = (x * f64::from(image.width())).floor() as u32;
        let top = (y * f64::from(image.height())).floor() as u32;
        let right = ((x + width) * f64::from(image.width()))
            .ceil()
            .min(f64::from(image.width())) as u32;
        let bottom = ((y + height) * f64::from(image.height()))
            .ceil()
            .min(f64::from(image.height())) as u32;
        if right <= left || bottom <= top {
            return Err("native_browser_preview_empty_bounds".into());
        }
        image = image.crop_imm(left, top, right - left, bottom - top);
    }
    let image = image
        .thumbnail(image.width().min(720), image.height().min(720))
        .to_rgb8();
    let mut bytes = Vec::new();
    JpegEncoder::new_with_quality(&mut bytes, 70)
        .encode_image(&image)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 1_048_576 {
        return Err("native_browser_preview_frame_too_large".into());
    }
    Ok((bytes, image.width(), image.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_landscape_and_small_frames_keep_their_aspect_and_jpeg_contract() {
        for (width, height, expected) in [
            (1920, 1080, (720, 405)),
            (900, 1800, (360, 720)),
            (24, 16, (24, 16)),
        ] {
            let input = image::RgbImage::from_fn(width, height, |x, y| {
                image::Rgb([x as u8, y as u8, (x ^ y) as u8])
            });
            let mut png = Cursor::new(Vec::new());
            input.write_to(&mut png, ImageFormat::Png).unwrap();
            let (bytes, width, height) = jpeg(png.get_ref()).unwrap();
            assert_eq!((width, height), expected);
            assert!(bytes.len() <= 1_048_576);
            let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg).unwrap();
            assert_eq!((decoded.width(), decoded.height()), expected);
        }
        assert!(jpeg(b"not a PNG").is_err());
    }
}
