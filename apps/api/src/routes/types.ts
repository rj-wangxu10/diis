import type { ApiResult } from "@diis/contracts";
import type { LocalDataGateway } from "@diis/data-gateway";
import type { FileAssetService } from "@diis/files";
import type { LocalKnowledgeService } from "@diis/knowledge";
import type { MetadataStore } from "@diis/metadata";
import type { RunCancelRegistry } from "../run-cancel-registry.js";

export type ConfigApiContext = {
  dataGateway: LocalDataGateway;
  fileAssetService: FileAssetService;
  knowledgeService: LocalKnowledgeService;
  metadataStore: MetadataStore;
  runCancelRegistry: RunCancelRegistry;
  userId: string;
  workspaceId?: string;
};

export type ConfigApiResponse = {
  body: ApiResult<unknown> | Buffer | Record<string, unknown>;
  headers?: Record<string, string>;
  status: number;
};
