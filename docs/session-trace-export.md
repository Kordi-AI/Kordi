# Session trace export

Export saves the complete trajectory of one chat as a JSON Lines file. It works for every chat kind in the sidebar: local agent sessions, direct chats with a contact, group channels with people and agents, personal agent sessions and cloud agent sessions.

## Where it is

Right-click a chat in the sidebar and choose **Export**. On the Mac a Save dialog opens; cancelling it does nothing. In the web app the file downloads. The file is named `kordi-trace-<title>-<YYYYMMDD-HHmm>.jsonl`. A failed export shows one line above the chat list.

## What is collected

Export reads the whole history, not only what the chat view has loaded:

- A local agent session on this Mac reads the runtime transcript, including every tool call and result.
- Any other chat reads every page of its local history in timeline order.
- A chat held by the server (direct chats, groups and cloud agent sessions) is completed from every server page. Rows this device already shows keep their rendered form; the server fills the rest.

Any read error fails the export; a written file always has `"complete": true`.

## File format

Schema `kordi.session-trace`, version 1. Line 1 describes the session; each following line is one message, oldest first. Optional fields are omitted rather than written as `null`. Timestamps are RFC 3339 UTC.

```jsonl
{"type":"session","schema":"kordi.session-trace","version":1,"exported_at":"2026-11-14T17:40:00.000Z","app_version":"0.0.2","session":{"id":"session:group:launch","kind":"group","title":"Launch","created_at":"2026-11-14T09:00:00.000Z"},"participants":[{"id":"human:acct_alex","name":"Alex","kind":"human","role":"self"},{"id":"agent:alex","name":"Kordi","kind":"agent","role":"owned-agent","owner_id":"human:acct_alex"}],"exported_by":"acct_alex","message_count":2,"complete":true}
{"type":"message","id":"m1","seq":1,"timestamp":"2026-11-14T09:01:00.000Z","sender":{"id":"human:acct_alex","name":"Alex","kind":"human"},"role":"user","text":"@Kordi find a venue","attachments":[{"name":"map.png","mime":"image/png","size":2048}]}
{"type":"message","id":"m2","seq":2,"timestamp":"2026-11-14T09:01:20.000Z","sender":{"id":"agent:alex","name":"Kordi","kind":"agent"},"role":"assistant","text":"The Harbor Hall is free on Friday.","reply_to":"m1","agent_turn":{"status":"complete","started_at":"2026-11-14T09:01:02.000Z","completed_at":"2026-11-14T09:01:20.000Z","thinking":"Check the venue list","tools":[{"id":"t1","name":"web_search","status":"done","arguments":"{\"query\":\"venues\"}","result":"Harbor Hall","is_error":false}]}}
```

Session line fields: `type`, `schema`, `version`, `exported_at`, `app_version` (Mac only), `session` (`id`, `kind`, `title`, `created_at`, `project`), `participants` (`id`, `name`, `kind`, `role`, `owner_id`), `exported_by`, `message_count`, `complete`.

Message line fields: `type`, `id`, `seq`, `timestamp`, `sender` (`id`, `name`, `kind`: `human`, `agent` or `system`), `role` (`user`, `assistant` or `system`), `kind`, `text`, `reply_to`, `attachments` (`name`, `mime`, `size`), and `agent_turn` (`status`, `model`, `provider`, `started_at`, `completed_at`, `thinking`, `segments`, `tools`, `error`).

## Privacy

- The file holds only what the exporting person's app can already show. It never reads another member's agent reasoning or raw tool payloads; an agent turn carries `thinking` and `tools` only where the chat view would show that trace to this viewer, such as the viewer's own agent.
- Attachments are listed by name, type and size. File contents, image data, download links and local file paths are never written.
- Tool arguments, tool results and thinking pass through the same secret redaction used for shared execution traces, which masks bearer tokens, common API key formats and `token=`/`password=`-style values.
