import { NestFactory } from "@nestjs/core";
import { configureApp } from "./app.config";
import { AppModule } from "./app.module";
import { Env } from "./env";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  await app.listen(Env.port);
}

void bootstrap();
