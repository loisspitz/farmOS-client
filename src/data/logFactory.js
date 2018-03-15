// A helper function for creating new log items with default properties
// TODO: a User ID will also be needed to sync with server
export function logFactory ({
  field_farm_images = [],
  // TODO: Are we allowing for multiple images/uris?
  local_image_uris = [],
  field_farm_area = [],
  field_farm_asset = [],
  field_farm_geofield = [],
  // TODO: Owner should be identified by user id, once we have authentication
  field_farm_log_owner = '',
  field_farm_notes = '',
  // TODO: Should this be a number, or should the view be able to handle multiple inputs?
  field_farm_quantity = [],
  id = null,
  local_id = null,
  name = '',
  type = '',
  timestamp = '',
  done = false,
  isCachedLocally = false,
  // TODO: A timestamp might be better than a boolean for tracking remote sync
  isSyncedWithServer = false,
} = {}) {
  return {
    field_farm_images,
    local_image_uris,
    field_farm_area,
    field_farm_asset,
    field_farm_geofield,
    field_farm_log_owner,
    field_farm_notes,
    field_farm_quantity,
    id,
    local_id,
    name,
    type,
    timestamp,
    done,
    isCachedLocally,
    isSyncedWithServer,
  }
}
