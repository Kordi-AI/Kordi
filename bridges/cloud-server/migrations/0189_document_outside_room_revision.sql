-- The revision of the latest save that did not come from a collaboration
-- room (docs/development/issue-1741-shared-documents.md).
--
-- A revisioned save, by a person or an agent, sets it to the revision it
-- produced; room snapshots leave it alone. A snapshot that sends
-- `baseRevision` conflicts when this is newer, so it cannot overwrite a save
-- the room has not seen. 0 means there has been no such save.
SET LOCAL lock_timeout = '5s';

ALTER TABLE cloud_document_contents
    ADD COLUMN IF NOT EXISTS outside_room_revision BIGINT NOT NULL DEFAULT 0;
