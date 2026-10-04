/**
 * Коннектор Claude ⇄ OpenAI Images (gpt-image-1).
 *
 * Устройство:
 *  - OAuthProvider (@cloudflare/workers-oauth-provider) делает воркер
 *    полноценным OAuth-сервером для claude.ai: /authorize, /token, /register.
 *  - На /authorize пользователь один раз вставляет API-ключ OpenAI;
 *    ключ проверяется живым запросом и уезжает в props гранта.
 *  - Запросы к /mcp — MCP-протокол (mcp-server.ts).
 *  - Сгенерированные PNG хранятся в KV 30 дней и раздаются публично
 *    по неугадываемым ссылкам /i/<uuid> (oa-auth.ts).
 */
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { OaAuthHandler } from "./oa-auth";
import { mcpHandler } from "./mcp-server";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: mcpHandler as any,
  defaultHandler: OaAuthHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
