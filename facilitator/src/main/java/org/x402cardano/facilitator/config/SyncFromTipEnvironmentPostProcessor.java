package org.x402cardano.facilitator.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

/**
 * Resolves a recent preprod block (tip minus N) from Blockfrost and injects it as
 * yaci-store's sync start point, so the demo facilitator is chain-current in
 * seconds instead of syncing preprod from genesis. Skipped when disabled, when
 * an explicit start point is configured, or when Blockfrost is unreachable
 * (yaci-store then falls back to its default behavior — log loudly).
 */
public class SyncFromTipEnvironmentPostProcessor implements EnvironmentPostProcessor {
    @Override
    public void postProcessEnvironment(ConfigurableEnvironment env, SpringApplication app) {
        if (!"true".equalsIgnoreCase(env.getProperty("x402.sync-from-tip.enabled", "true"))) return;
        if (env.getProperty("store.cardano.sync-start-slot") != null) return; // explicit wins
        String baseUrl = env.getProperty("x402.blockfrost.base-url",
                "https://cardano-preprod.blockfrost.io/api/v0");
        String projectId = env.getProperty("x402.blockfrost.project-id", "");
        if (projectId.isBlank()) {
            System.err.println("[sync-from-tip] BLOCKFROST_PROJECT_ID missing - yaci-store will sync from its default start point");
            return;
        }
        int blocksBehind = Integer.parseInt(env.getProperty("x402.sync-from-tip.blocks-behind", "30"));
        try {
            HttpClient http = HttpClient.newHttpClient();
            ObjectMapper json = new ObjectMapper();
            JsonNode latest = fetch(http, json, baseUrl + "/blocks/latest", projectId);
            long targetHeight = latest.get("height").asLong() - blocksBehind;
            JsonNode target = fetch(http, json, baseUrl + "/blocks/" + targetHeight, projectId);
            long slot = target.get("slot").asLong();
            String hash = target.get("hash").asText();
            env.getPropertySources().addFirst(new MapPropertySource("syncFromTip", Map.of(
                    "store.cardano.sync-start-slot", slot,
                    "store.cardano.sync-start-blockhash", hash)));
            System.out.println("[sync-from-tip] yaci-store will sync preprod from slot " + slot
                    + " (block " + targetHeight + ", " + blocksBehind + " behind tip)");
        } catch (Exception e) {
            System.err.println("[sync-from-tip] failed to resolve tip via Blockfrost: " + e.getMessage());
        }
    }

    private JsonNode fetch(HttpClient http, ObjectMapper json, String url, String projectId) throws Exception {
        HttpResponse<String> res = http.send(HttpRequest.newBuilder(URI.create(url))
                        .header("project_id", projectId).GET().build(),
                HttpResponse.BodyHandlers.ofString());
        if (res.statusCode() != 200) throw new IllegalStateException(url + " -> HTTP " + res.statusCode());
        return json.readTree(res.body());
    }
}
