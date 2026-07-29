/** The `projects` bounded context: what is deployable, and how. */

export { ProjectName, ProjectSlug } from "./project-name";
export { PublicRoute } from "./public-route";
export { HealthCheckSpec } from "./health-check-spec";
export type { HealthCheckSpecInput } from "./health-check-spec";
export { BuildArgs } from "./build-args";
export { ImageRetention, MINIMUM_IMAGE_RETENTION } from "./image-retention";
export { DeployConfig } from "./deploy-config";
export type { DeployConfigInput } from "./deploy-config";
export { Project } from "./project";
export type { ProjectInput } from "./project";
