import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "./auth.types";
import { extractBearerToken, verifyAccessToken } from "./jwt-auth.utils";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    const payload = verifyAccessToken(token);

    request.user = {
      userId: payload.sub,
      uniqueName: payload.uniqueName,
    };

    return true;
  }
}
