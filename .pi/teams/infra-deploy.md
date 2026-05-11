---
name: infra-deploy
description: Infrastructure and deployment team for production readiness
agents: infra, deployment
orchestrator: architect
---
This team handles infrastructure setup, CI/CD pipeline configuration, and production deployment.

## Typical Workflows
- Dockerizing an application
- Setting up CI/CD pipelines
- Cloud deployment configuration
- Production release and rollback
- Monitoring and alerting setup

## Coordination Pattern
1. Infra sets up the foundation (Docker, cloud config, CI/CD)
2. Deployment handles the release process (versioning, health checks, rollback plans)
3. Both agents share context about the deployment target and requirements