/**
 * Which photos come in, and what is said about the ones that cannot.
 *
 * HEIC is what an iPhone shoots, and what a Samsung shoots on "high
 * efficiency". Some browsers read it (Safari) and most do not (Chrome,
 * Firefox, the Android app's web view), and an iPhone converts it to JPEG by
 * itself - but only if the picker does not ask for HEIC. These pin that
 * split, and the sentence a person gets when their browser cannot read one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isHeic, mayBePhoto, photoAccept, unreadablePhoto, putPhoto, PHOTO_TYPES } from '../assets/js/lib/photos.js';

test('photos: HEIC is known by its type, or by its name when the type is blank', () => {
  assert.equal(isHeic('image/heic'), true);
  assert.equal(isHeic('image/HEIF'), true);
  assert.equal(isHeic('', 'IMG_4021.HEIC'), true, 'Chrome on Windows leaves the type blank');
  assert.equal(isHeic('image/jpeg', 'IMG_4021.jpg'), false);
});

test('photos: any image is worth trying; a document is not', () => {
  for (const type of [...PHOTO_TYPES, 'image/heic', 'image/tiff', 'image/bmp']) assert.equal(mayBePhoto(type), true, type);
  assert.equal(mayBePhoto('', 'IMG_1.heic'), true);
  assert.equal(mayBePhoto('application/pdf', 'map.pdf'), false);
  assert.equal(mayBePhoto('', 'notes.txt'), false);
});

test('photos: an iPhone is asked for the shown-as-is types, so it converts HEIC itself', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
  assert.equal(photoAccept({ userAgent: iphone }), PHOTO_TYPES.join(','));
  assert.doesNotMatch(photoAccept({ userAgent: iphone }), /heic|image\/\*/);
  assert.equal(photoAccept({ userAgent: mac, touchMac: true }), PHOTO_TYPES.join(','), 'an iPad');
  // Everywhere else, any image and HEIC by name.
  assert.equal(photoAccept({ userAgent: mac }), 'image/*,.heic,.heif');
  assert.equal(photoAccept({ userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile' }), 'image/*,.heic,.heif');
});

test('photos: what is said about a photo that cannot be read depends on what it is', () => {
  assert.match(unreadablePhoto('IMG_4021.HEIC', 'image/heic'), /HEIC photo, which this browser cannot read.*on a Mac.*Samsung/);
  assert.match(unreadablePhoto('DSC_0001.NEF', ''), /RAW file.*Export it as a JPEG/);
  assert.match(unreadablePhoto('IMG.dng', 'image/x-adobe-dng'), /RAW file/);
  assert.match(unreadablePhoto('scan.tiff', 'image/tiff'), /could not be read as a photo/);
  assert.match(unreadablePhoto('', 'image/heic'), /^That photo is a HEIC photo/);
});

test('photos: a HEIC this browser cannot read is refused in words, never stored as it came', async () => {
  // Node has no image decoder, which is exactly a browser that cannot read HEIC.
  const heic = new Blob([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], { type: 'image/heic' });
  await assert.rejects(putPhoto(heic, { name: 'IMG_4021.HEIC' }), /HEIC photo, which this browser cannot read/);
  const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
  await assert.rejects(putPhoto(pdf, { name: 'map.pdf' }), /could not be read as a photo/);
});
