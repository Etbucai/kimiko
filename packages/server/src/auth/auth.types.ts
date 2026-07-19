import type { IncomingHttpHeaders } from "node:http";

export interface AuthenticatedUser {
  userId: string;
  uniqueName: string;
}

export interface AccessTokenPayload {
  sub: string;
  uniqueName: string;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest {
  headers: IncomingHttpHeaders;
  user?: AuthenticatedUser;
}
