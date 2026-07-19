import { Test, type TestingModule } from "@nestjs/testing";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

describe("AppController", () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe("root", () => {
    it("should return server status text", () => {
      expect(appController.getHello()).toContain("Kimiko server is running");
    });
  });

  describe("health", () => {
    it("should return a valid health payload", () => {
      const health = appController.getHealth();

      expect(health.status).toBe("ok");
      expect(new Date(health.timestamp).toString()).not.toBe("Invalid Date");
    });
  });
});
