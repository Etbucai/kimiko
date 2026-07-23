import { createHmac, timingSafeEqual } from "node:crypto";
import { UnauthorizedException } from "@nestjs/common";
import { Env } from "../env";
import type { AccessTokenPayload } from "./auth.types";

const JWT_ALGORITHM = "HS256";
const JWT_TYPE = "JWT";

export const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

interface JwtHeader {
  alg: typeof JWT_ALGORITHM;
  typ: typeof JWT_TYPE;
}

export function extractBearerToken(
  authorizationHeader: string | undefined,
): string {
  if (!authorizationHeader) {
    throw new UnauthorizedException("Missing Authorization header");
  }

  const parts = authorizationHeader.trim().split(/\s+/);
  const [scheme, token] = parts;
  if (
    parts.length !== 2 ||
    scheme !== "Bearer" ||
    token === undefined ||
    token.length === 0
  ) {
    throw new UnauthorizedException(
      "Authorization header must use Bearer token format",
    );
  }

  return token;
}

export function signAccessToken(
  payload: Pick<AccessTokenPayload, "sub" | "uniqueName">,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header: JwtHeader = {
    alg: JWT_ALGORITHM,
    typ: JWT_TYPE,
  };
  const tokenPayload: AccessTokenPayload = {
    ...payload,
    iat: issuedAt,
    exp: issuedAt + ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  };

  const headerPart = encodeJsonPart(header);
  const payloadPart = encodeJsonPart(tokenPayload);
  const signingInput = `${headerPart}.${payloadPart}`;
  const signaturePart = signInput(signingInput);

  return `${signingInput}.${signaturePart}`;
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const { headerPart, payloadPart, signaturePart } = parseToken(token);
    const signingInput = `${headerPart}.${payloadPart}`;
    const expectedSignature = signInput(signingInput);

    if (!constantTimeEqual(signaturePart, expectedSignature)) {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const header = decodeJsonPart(headerPart);
    if (!isJwtHeader(header)) {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const payload = decodeJsonPart(payloadPart);
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException("Invalid or expired token");
    }

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp <= now) {
      throw new UnauthorizedException("Invalid or expired token");
    }

    return payload;
  } catch (error: unknown) {
    if (error instanceof UnauthorizedException) {
      throw error;
    }

    throw new UnauthorizedException("Invalid or expired token");
  }
}

function encodeJsonPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeJsonPart(value: string): unknown {
  return JSON.parse(
    Buffer.from(value, "base64url").toString("utf8"),
  ) as unknown;
}

function parseToken(token: string): Readonly<{
  headerPart: string;
  payloadPart: string;
  signaturePart: string;
}> {
  const parts = token.split(".");
  const [headerPart, payloadPart, signaturePart] = parts;

  if (
    parts.length !== 3 ||
    headerPart === undefined ||
    headerPart.length === 0 ||
    payloadPart === undefined ||
    payloadPart.length === 0 ||
    signaturePart === undefined ||
    signaturePart.length === 0
  ) {
    throw new UnauthorizedException("Invalid or expired token");
  }

  return { headerPart, payloadPart, signaturePart };
}

function signInput(input: string): string {
  return createHmac("sha256", Env.jwtSecret).update(input).digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJwtHeader(value: unknown): value is JwtHeader {
  return (
    isRecord(value) && value.alg === JWT_ALGORITHM && value.typ === JWT_TYPE
  );
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function isUnixTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value > 0
  );
}

function isAccessTokenPayload(value: unknown): value is AccessTokenPayload {
  return (
    isRecord(value) &&
    isPositiveIntegerString(value.sub) &&
    typeof value.uniqueName === "string" &&
    value.uniqueName.length > 0 &&
    (value.iat === undefined || isUnixTimestamp(value.iat)) &&
    isUnixTimestamp(value.exp)
  );
}
