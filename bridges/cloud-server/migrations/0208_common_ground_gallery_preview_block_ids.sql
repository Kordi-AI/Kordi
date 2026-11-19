-- Room gallery previews without block-id comments. The document editor
-- stamps each Markdown block with `<!-- k:... -->`, and the stored document
-- source keeps it. Previews of shared Kordi documents were cut from that
-- source, so readers saw the comments after each paragraph. The server now
-- cuts previews from the text without them; this repairs the previews copied
-- before, as the next save of the document would.
--
-- Only items of a document with stored text whose preview holds `<!--`
-- change. A line that held only block-id comments goes with its line break;
-- comments ending a line go with the spaces around them; any other block-id
-- comment goes. The start of a block-id comment that the 800-character cut
-- left at the end goes too. Ordinary HTML comments stay. A preview left blank
-- becomes NULL. Running it again changes nothing.
SET LOCAL lock_timeout = '5s';

WITH stripped AS (
    SELECT item.item_id,
           regexp_replace(
               regexp_replace(
                   regexp_replace(
                       regexp_replace(
                           item.preview,
                           -- A line of nothing but block-id comments, with its line break.
                           '^[ \t]*(<!--\s*k:[A-Za-z0-9_-]{4,32}\s*-->[ \t]*)+\r?(\n|$)',
                           '', 'gn'),
                       -- Block-id comments ending a line, with the spaces around them.
                       '([ \t]*<!--\s*k:[A-Za-z0-9_-]{4,32}\s*-->)+[ \t]*(?=\r?(\n|$))',
                       '', 'gn'),
                   -- Any other block-id comment.
                   '<!--\s*k:[A-Za-z0-9_-]{4,32}\s*-->',
                   '', 'g'),
               -- The cut-off start of a block-id comment ending the preview.
               '([ \t]*<!--\s*(k(:[A-Za-z0-9_-]{0,32}(\s*-{1,2}|\s+)?)?)?)+$',
               '', '') AS preview
    FROM cloud_common_ground_room_gallery_items item
    WHERE item.preview LIKE '%<!--%'
      AND EXISTS (
          SELECT 1 FROM cloud_document_contents contents
          WHERE contents.attachment_id = item.attachment_id
      )
),
cleaned AS (
    SELECT item_id, CASE WHEN preview ~ '^\s*$' THEN NULL ELSE preview END AS preview
    FROM stripped
)
UPDATE cloud_common_ground_room_gallery_items item
SET preview = cleaned.preview
FROM cleaned
WHERE item.item_id = cleaned.item_id
  AND item.preview IS DISTINCT FROM cleaned.preview;
