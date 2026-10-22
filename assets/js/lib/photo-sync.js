/**
 * The photos on pins, between devices.
 *
 * A pin has always carried only the ids of its photos; the pictures stayed in
 * the browser that took them (lib/photos.js). With Premium they are uploaded
 * too, one object each in the `pin-photos` bucket at `<uploader>/<photo id>`,
 * and the pin's record of each photo gains `by`, the uploader's account id.
 * That one field is the whole protocol:
 *
 *   - a photo with no `by` is still only on the device that took it, and is
 *     waiting to be uploaded from there;
 *   - a photo with a `by` is in the bucket, and any device that can see the
 *     pin can fetch it from `<by>/<id>` - the storage policy decides whether
 *     it may (supabase/schema.sql, "pin photos").
 *
 * `by` is set only once the upload has gone through, so a pin never points
 * another device at a picture that is not there.
 *
 * Pure: no storage, no network. What to upload and where a photo lives are
 * decided here and tested on their own; the viewer does the moving.
 */

import { canEdit } from './shares.js';

/** The storage bucket, as supabase/schema.sql makes it. */
export const PHOTO_BUCKET = 'pin-photos';

/**
 * The most a photo may weigh to be uploaded: the bucket's own limit.
 *
 * Every photo is shrunk under 100 KB on the way in, so this is only reached by
 * one the browser could not shrink - which stays on its device rather than
 * being refused by the server on every sync.
 */
export const PHOTO_SYNC_LIMIT = 256 * 1024;

/** Where an uploaded photo lives in the bucket. */
export function photoPath(by, id) {
  return `${by}/${id}`;
}

/** Whether a photo has been uploaded, and so can be fetched by another device. */
export function isUploaded(photo) {
  return typeof photo?.by === 'string' && photo.by.length > 0;
}

/**
 * The photos this device should upload: on a pin it may change, and not
 * uploaded yet.
 *
 * A folder somebody shared for viewing is left alone - recording the upload
 * on its pins is a change to their folder, which the folder's own policies
 * would refuse - and the owner's device uploads its own pictures anyway.
 *
 * @returns {{folderId: string, itemId: string, photoId: string}[]}
 */
export function photosToUpload(folders = []) {
  const out = [];
  for (const folder of folders) {
    if (!folder || folder.deleted || !canEdit(folder)) continue;
    for (const item of folder.items || []) {
      for (const photo of item?.feature?.properties?.photos || []) {
        if (photo?.id && !isUploaded(photo)) out.push({ folderId: folder.id, itemId: item.id, photoId: photo.id });
      }
    }
  }
  return out;
}

/**
 * The uploaded photos on these pins that this account may take down.
 *
 * Only its own: the bucket lets an account remove what it uploaded and
 * nothing else, so asking to remove a collaborator's picture would be
 * refused - and is not this account's to ask. Called after the pins are
 * gone, with what is still referenced, so a photo that is also on a pin that
 * remains is left where it is.
 *
 * @returns {string[]} bucket paths
 */
export function ownUploads(items = [], me = '', { stillUsed = [] } = {}) {
  if (!me) return [];
  // A photo on another pin as well - a copied pin carries the same ids - is
  // still in use, and stays.
  const keep = new Set(stillUsed);
  const paths = [];
  for (const item of items) {
    for (const photo of item?.feature?.properties?.photos || []) {
      if (photo?.id && photo.by === me && !keep.has(photo.id)) paths.push(photoPath(me, photo.id));
    }
  }
  return [...new Set(paths)];
}
