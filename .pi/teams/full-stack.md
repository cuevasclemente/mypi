---
name: full-stack
description: Full-stack development team covering frontend, backend, and database
agents: frontend, backend, database
orchestrator: architect
---
This team handles end-to-end feature development across the entire stack.

## Typical Workflows
- Feature implementation (frontend form + backend endpoint + database migration)
- Bug fixes spanning multiple layers
- API design and implementation
- Data model changes with corresponding UI updates

## Coordination Pattern
1. The architect analyzes the task and determines which team members are needed
2. Frontend and backend work can typically run in parallel
3. Database changes should be made first (migrations), then backend updated, then frontend
4. If the task only touches one surface, only dispatch the relevant agent