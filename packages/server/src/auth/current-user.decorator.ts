import {
  createParamDecorator,
  InternalServerErrorException,
} from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest, AuthenticatedUser } from "./auth.types";

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new InternalServerErrorException(
        "Authenticated user is not available on the request",
      );
    }

    return request.user;
  },
);
