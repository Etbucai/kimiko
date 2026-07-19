import { Injectable } from "@nestjs/common";
import { HealthStatusSchema, type HealthStatus } from "@kimiko/schema";
import { formatDate } from "@kimiko/utils";

@Injectable()
export class AppService {
  getHello(): string {
    return `Kimiko server is running (${formatDate(new Date())})`;
  }

  getHealth(): HealthStatus {
    return HealthStatusSchema.parse({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  }
}
