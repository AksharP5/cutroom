The before/after captures use the same generated 640x360 composition and linked card.html, shown in Chromium at 1720x1050. The index, document and card are backdated three days; the MCP SDK then writes only card.html. Before is 953d3e7. After is the review fix on truthful-status, rebased onto dc60f74.

On 953d3e7, Home renders the fresh child in its poster while still saying "3 d ago". After the fix it renders the same fresh title and says "Just now". The separate viewer capture confirms the edited child renders in the composition.

The regression logs run the two new unit test files and the linked-source browser test on 953d3e7. The idle-clock checks get HTTP 200 instead of 404; the linked-source date stays at its old timestamp.

http-expiry.json comes from 150 real SDK clients connecting to a Bun HTTP server on port 4932 and calling client.close(). The server uses the production handler with an injected scheduler. Advancing it by 30 virtual minutes returns 404 for every old session; a fresh client can list tools. No wall-clock timeout wait or global clock patch was used. Unit tests also verify rolling activity deadlines, cancellation of expiry timers on disposal, closure of a real transport stream, and protection of an in-flight tool across an hour of virtual time.

validation.txt records the full runs and the focused correction for the offscreen-tile test fixture. populated-rerun.log uses the full run's library of 327 projects.
