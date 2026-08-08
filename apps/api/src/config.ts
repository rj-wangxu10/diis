import { createEnvConfig } from "@diis/contracts";

export type ApiConfig = {
  host: string;
  port: number;
};

export const loadApiConfig = (): ApiConfig => createEnvConfig(process.env).api;
