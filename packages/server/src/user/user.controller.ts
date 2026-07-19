import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import type {
  GetMyUserInfoResponse,
  LoginUserResponse,
  LogoutUserResponse,
  RefreshTokenResponse,
  RegisterUserResponse,
} from "@kimiko/schema";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { UserService } from "./user.service";

@Controller("user")
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post("register")
  register(@Body() body: unknown): Promise<RegisterUserResponse> {
    return this.userService.register(body);
  }

  @Post("login")
  async login(@Body() body: unknown): Promise<LoginUserResponse> {
    const session = await this.userService.login(body);
    const me = await this.userService.getUserInfo(session.userId);

    return { session, me };
  }

  @Post("refresh")
  async refresh(@Body() body: unknown): Promise<RefreshTokenResponse> {
    const session = await this.userService.refresh(body);

    return { session };
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  logout(
    @Body() body: unknown,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<LogoutUserResponse> {
    return this.userService.logout(body, currentUser.userId);
  }

  @Post("me")
  @UseGuards(JwtAuthGuard)
  me(
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<GetMyUserInfoResponse> {
    return this.userService.getUserInfo(currentUser.userId);
  }
}
