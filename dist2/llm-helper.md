1. [FORMAT INSTRUCTIONS]
2. This doc is extremely compressed for LLM ingestion.
4. Lines are few; abbreviations used where possible.
5. "->" indicates ownership/management.
6. "()" groups subcomponents or clarifications.
7. Use @filename for direct references.

8. [DOC START]
9. RMS=Resource Management System: manages resources/creep lifecycle (@resourceManager.js).
10. Entities: RM (ResourceManager), SC (@SourceController.js), RC (@RoomController.js), SpC (@SpawnController.js).
11. RM -> (CO=CreepOrder @resources.creepOrder.js, SP=SpawnProcess @resources.spawnProcess.js).
12. SC -> ensures source harvesters (terrain checks, CO creation).
13. RC -> orchestrates room logic, organizes source teams (harvester, mule, upgrader).
14. SpC -> spawns creeps from CO, updates SP status.
15. CO: persistent creep need {role, priority, status, memory}.
16. SP: spawn event tracking {orderId, spawnId, status}.
17. Priority = unique num from sourceId => stable ordering (harvester > mule).
18. Mule role (@role.mule.js): state machine IDLE->COLLECT->DELIVER, uses task templates (entity/area).
19. Upgrader role (@role.upgrader.js) invests energy in controller.
20. Harvester role (@role.harvester.js) gathers energy.
21. Memory persists CO/SP/roles/tasks across resets.
22. Lifecycle: CO (pending->spawning->active->pending), SP (spawning->done/fail).
23. RoleRegistry (@roles.js) runs creep roles; ErrorHandler logs invalid roles (@logger.js).
24. On tick1 => init system (register resources, load data); subsequent => reconcile state.
25. Core flow: SC/RC/SpC -> RM -> updates CO/SP => consistent spawn, roles, priorities.
26. Overall => stable mgmt, easy expansions, persistent tasks.
27. [DOC END]
