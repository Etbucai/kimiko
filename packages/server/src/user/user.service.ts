import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq, lt } from "drizzle-orm";
import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import type {
  GetMyUserInfoResponse,
  LoginSession,
  LoginUserRequest,
  LogoutUserRequest,
  LogoutUserResponse,
  RefreshTokenRequest,
  RegisterUserRequest,
  RegisterUserResponse,
} from "@kimiko/schema";
import {
  LoginUserRequestSchema,
  LogoutUserRequestSchema,
  RefreshTokenRequestSchema,
  RegisterUserRequestSchema,
  TokenType,
} from "@kimiko/schema";
import { userRefreshSessions, users } from "../database/schema";
import { DatabaseService } from "../database/database.service";
import {
  ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  signAccessToken,
} from "../auth/jwt-auth.utils";
import type { AccessTokenPayload } from "../auth/auth.types";

const REFRESH_TOKEN_EXPIRES_IN_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_KEY_LENGTH = 64;
const PASSWORD_HASH_SALT_BYTES = 16;
const PASSWORD_HASH_PREFIX = "scrypt:v1";

type SchemaParseResult<T> =
  | Readonly<{ success: true; data: T }>
  | Readonly<{
      success: false;
      error: {
        issues: readonly {
          path: readonly PropertyKey[];
          message: string;
        }[];
      };
    }>;

interface SqliteConstraintError {
  code: string;
  message: string;
}

@Injectable()
export class UserService {
  constructor(private readonly databaseService: DatabaseService) {}

  async register(body: unknown): Promise<RegisterUserResponse> {
    const request = parseRequest<RegisterUserRequest>(
      RegisterUserRequestSchema.safeParse(body),
    );

    const existingUser = await this.databaseService.db
      .select({
        id: users.id,
      })
      .from(users)
      .where(eq(users.uniqueName, request.uniqueName))
      .limit(1);

    if (existingUser.length > 0) {
      throw new ConflictException(
        `uniqueName "${request.uniqueName}" is already taken`,
      );
    }

    const passwordHash = await hashPassword(request.password);

    try {
      const [createdUser] = await this.databaseService.db
        .insert(users)
        .values({
          uniqueName: request.uniqueName,
          displayName: request.displayName,
          password: passwordHash,
        })
        .returning({
          id: users.id,
        });

      if (!createdUser) {
        throw new InternalServerErrorException("Failed to create user");
      }

      return {
        userId: String(createdUser.id),
      };
    } catch (error: unknown) {
      if (isUniqueNameConflict(error)) {
        throw new ConflictException(
          `uniqueName "${request.uniqueName}" is already taken`,
        );
      }

      throw error;
    }
  }

  async login(body: unknown): Promise<LoginSession> {
    const request = parseRequest<LoginUserRequest>(
      LoginUserRequestSchema.safeParse(body),
    );

    const [user] = await this.databaseService.db
      .select({
        id: users.id,
        uniqueName: users.uniqueName,
        password: users.password,
      })
      .from(users)
      .where(eq(users.uniqueName, request.uniqueName))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException("Invalid uniqueName or password");
    }

    const passwordMatches = await verifyPassword(
      request.password,
      user.password,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException("Invalid uniqueName or password");
    }

    const refreshToken = this.generateRefreshToken();
    await this.databaseService.db.insert(userRefreshSessions).values({
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: this.getRefreshTokenExpiresAt(),
    });

    return this.createTokenResponse(
      {
        sub: String(user.id),
        uniqueName: user.uniqueName,
      },
      refreshToken,
    );
  }

  async refresh(body: unknown): Promise<LoginSession> {
    const request = parseRequest<RefreshTokenRequest>(
      RefreshTokenRequestSchema.safeParse(body),
    );
    const refreshTokenHash = hashRefreshToken(request.refreshToken);

    await this.deleteExpiredRefreshSessions();

    const [session] = await this.databaseService.db
      .select({
        id: userRefreshSessions.id,
        userId: userRefreshSessions.userId,
      })
      .from(userRefreshSessions)
      .where(eq(userRefreshSessions.tokenHash, refreshTokenHash))
      .limit(1);

    if (!session) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const [user] = await this.databaseService.db
      .select({
        id: users.id,
        uniqueName: users.uniqueName,
      })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);

    if (!user) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    await this.databaseService.db
      .delete(userRefreshSessions)
      .where(eq(userRefreshSessions.id, session.id));

    const nextRefreshToken = this.generateRefreshToken();
    await this.databaseService.db.insert(userRefreshSessions).values({
      userId: user.id,
      tokenHash: hashRefreshToken(nextRefreshToken),
      expiresAt: this.getRefreshTokenExpiresAt(),
    });

    return this.createTokenResponse(
      {
        sub: String(user.id),
        uniqueName: user.uniqueName,
      },
      nextRefreshToken,
    );
  }

  async logout(
    body: unknown,
    currentUserId: string,
  ): Promise<LogoutUserResponse> {
    const request = parseRequest<LogoutUserRequest>(
      LogoutUserRequestSchema.safeParse(body),
    );
    const userId = this.parseUserId(currentUserId);
    const refreshTokenHash = hashRefreshToken(request.refreshToken);

    await this.deleteExpiredRefreshSessions();

    const [session] = await this.databaseService.db
      .select({
        id: userRefreshSessions.id,
      })
      .from(userRefreshSessions)
      .where(
        and(
          eq(userRefreshSessions.tokenHash, refreshTokenHash),
          eq(userRefreshSessions.userId, userId),
        ),
      )
      .limit(1);

    if (!session) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    await this.databaseService.db
      .delete(userRefreshSessions)
      .where(eq(userRefreshSessions.id, session.id));

    return {};
  }

  async getUserInfo(userIdString: string): Promise<GetMyUserInfoResponse> {
    const userId = this.parseUserId(userIdString);
    const [user] = await this.databaseService.db
      .select({
        id: users.id,
        uniqueName: users.uniqueName,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      throw new NotFoundException("User not found");
    }

    return {
      userId: String(user.id),
      uniqueName: user.uniqueName,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl ?? "",
    };
  }

  private createTokenResponse(
    payload: Pick<AccessTokenPayload, "sub" | "uniqueName">,
    refreshToken: string,
  ): LoginSession {
    return {
      userId: payload.sub,
      accessToken: signAccessToken(payload),
      refreshToken,
      tokenType: TokenType.Bearer,
      expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
    };
  }

  private generateRefreshToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private getRefreshTokenExpiresAt(): Date {
    return new Date(Date.now() + REFRESH_TOKEN_EXPIRES_IN_MS);
  }

  private async deleteExpiredRefreshSessions(): Promise<void> {
    await this.databaseService.db
      .delete(userRefreshSessions)
      .where(lt(userRefreshSessions.expiresAt, new Date()));
  }

  private parseUserId(userId: string): number {
    if (!/^[1-9]\d*$/.test(userId)) {
      throw new UnauthorizedException("Invalid authenticated user");
    }

    const parsedUserId = Number(userId);
    if (!Number.isSafeInteger(parsedUserId)) {
      throw new UnauthorizedException("Invalid authenticated user");
    }

    return parsedUserId;
  }
}

function parseRequest<T>(result: SchemaParseResult<T>): T {
  if (result.success) {
    return result.data;
  }

  const firstIssue = result.error.issues[0];
  if (firstIssue === undefined) {
    throw new BadRequestException("Request body is invalid");
  }

  const fieldPath = firstIssue.path.map(String).join(".");
  const prefix = fieldPath.length > 0 ? `${fieldPath}: ` : "";
  throw new BadRequestException(`${prefix}${firstIssue.message}`);
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(PASSWORD_HASH_SALT_BYTES).toString("base64url");
  const derivedKey = await scryptPassword(password, salt);

  return `${PASSWORD_HASH_PREFIX}:${salt}:${derivedKey.toString("base64url")}`;
}

async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  const parts = passwordHash.split(":");
  const [algorithm, version, salt, expectedHash, ...rest] = parts;

  if (
    algorithm !== "scrypt" ||
    version !== "v1" ||
    salt === undefined ||
    salt.length === 0 ||
    expectedHash === undefined ||
    expectedHash.length === 0 ||
    rest.length > 0
  ) {
    return false;
  }

  const actualKey = await scryptPassword(password, salt);
  const expectedKey = Buffer.from(expectedHash, "base64url");

  return (
    expectedKey.length === actualKey.length &&
    timingSafeEqual(expectedKey, actualKey)
  );
}

function scryptPassword(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      PASSWORD_HASH_KEY_LENGTH,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function isUniqueNameConflict(error: unknown): error is SqliteConstraintError {
  if (!isSqliteConstraintError(error)) {
    return false;
  }

  return (
    error.code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (error.code === "SQLITE_CONSTRAINT" &&
      error.message.includes("user.unique_name"))
  );
}

function isSqliteConstraintError(
  error: unknown,
): error is SqliteConstraintError {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
