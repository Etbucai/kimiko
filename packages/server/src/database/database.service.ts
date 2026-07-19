import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE_DB } from "./database.constants";
import type { DrizzleDatabase } from "./database.types";

@Injectable()
export class DatabaseService {
  constructor(@Inject(DRIZZLE_DB) readonly db: DrizzleDatabase) {}
}
