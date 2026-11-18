# Read-side wiring

Construct one `ProjectionService(eventStore, projectionStore, clock, scheduler)`
and one `QueryService(eventStore, projectionService, runtimeMode)` per server.
Use a **dedicated** scheduler with its sink routed to `projectionService.onTimer`;
projection cache timers must not be appended as domain timer events. Close the
projection service before closing the scheduler or stores.

Snapshots load the current projection version, replay the workflow tail, and
return an owned `{ readModel, asOfSeq }` copy. Checkpoints save every 200 workflow
events or five idle seconds. Failed saves retain dirty state for a later event,
idle callback, or shutdown retry; the event log remains authoritative.

Global queries incrementally fold committed events with `evolveGlobal`. Gate
lists contain open gates; detail lookup also finds closed gates. Question lists
contain only escalated questions. Missing details return `null` for the HTTP
layer to map to 404. Event pages default to 200 entries and return `nextAfterSeq`
only when another entry exists. Templates remain the template repository's
responsibility. DTO validation and transport errors belong to the API layer.
