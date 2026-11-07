import { ServiceUnavailableException } from "@nestjs/common";
import { DEFAULT_MODEL_ID, SETTING_KEYS } from "shared";
import { resolveSub2ApiProviderConfig } from "./sub2api-provider-config";

describe("resolveSub2ApiProviderConfig", () => {
  it("uses the persisted effective settings used by the admin model test", async () => {
    const getEffectiveValue = jest.fn(async (key: string) => {
      if (key === SETTING_KEYS.SUB2API_BASE_URL) {
        return "https://ai.longdaoec.com/v1/";
      }
      if (key === SETTING_KEYS.SUB2API_API_KEY) {
        return "sk-admin-configured";
      }
      return undefined;
    });

    await expect(
      resolveSub2ApiProviderConfig({ getEffectiveValue }),
    ).resolves.toEqual({
      baseURL: "https://ai.longdaoec.com/v1",
      apiKey: "sk-admin-configured",
      // 系统设置没配默认模型时回落代码常量，调用方不必各自兜底
      defaultModel: DEFAULT_MODEL_ID,
    });
    expect(getEffectiveValue).toHaveBeenCalledWith(
      SETTING_KEYS.SUB2API_BASE_URL,
    );
    expect(getEffectiveValue).toHaveBeenCalledWith(
      SETTING_KEYS.SUB2API_API_KEY,
    );
    expect(getEffectiveValue).toHaveBeenCalledWith(
      SETTING_KEYS.SUB2API_DEFAULT_MODEL,
    );
  });

  it("honours the model configured in system settings", async () => {
    const getEffectiveValue = jest.fn(async (key: string) => {
      if (key === SETTING_KEYS.SUB2API_BASE_URL) return "https://relay.test/v1";
      if (key === SETTING_KEYS.SUB2API_API_KEY) return "sk-x";
      if (key === SETTING_KEYS.SUB2API_DEFAULT_MODEL) return "gemini-3.7-flash";
      return undefined;
    });

    await expect(
      resolveSub2ApiProviderConfig({ getEffectiveValue }),
    ).resolves.toMatchObject({ defaultModel: "gemini-3.7-flash" });
  });

  it("rejects missing credentials instead of sending requests to the web UI", async () => {
    const getEffectiveValue = jest.fn().mockResolvedValue(undefined);

    await expect(
      resolveSub2ApiProviderConfig({ getEffectiveValue }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
