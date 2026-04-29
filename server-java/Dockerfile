# Multi-stage build: stage 1 installs the x402 Java library from the sibling
# repo, stage 2 builds and runs the Spring Boot demo server.
#
# Build context : x402-cardano-demo/         (this repo)
# Named context : x402  →  ../x402            (Kammerlo/x402 fork)

# ---------------------------------------------------------------------------
# Stage 1 — build the x402 Java library jar.
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS x402lib

WORKDIR /workspace/x402-java
COPY --from=x402 java/pom.xml ./pom.xml
COPY --from=x402 java/checkstyle.xml ./checkstyle.xml
COPY --from=x402 java/checkstyle-suppressions.xml ./checkstyle-suppressions.xml
COPY --from=x402 java/spotbugs-exclude.xml ./spotbugs-exclude.xml
COPY --from=x402 java/src ./src

# Install to the local Maven repo so stage 2 can resolve org.x402:x402.
# Skip tests + lint here for build speed; the library is independently tested.
RUN mvn -B -q -DskipTests -Dcheckstyle.skip=true -Dspotbugs.skip=true install

# ---------------------------------------------------------------------------
# Stage 2 — build the Spring Boot server, reusing stage 1's local repo cache.
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS server-build

WORKDIR /workspace/server-java
# Carry the populated ~/.m2 from stage 1 so org.x402:x402 resolves locally.
COPY --from=x402lib /root/.m2 /root/.m2
COPY server-java/pom.xml ./pom.xml
COPY server-java/src ./src

RUN mvn -B -q -DskipTests package

# ---------------------------------------------------------------------------
# Stage 3 — minimal runtime image.
# ---------------------------------------------------------------------------
FROM eclipse-temurin:17-jre

WORKDIR /app
COPY --from=server-build /workspace/server-java/target/x402-cardano-demo-server-java-0.1.0.jar /app/server.jar

EXPOSE 8003
ENTRYPOINT ["java", "-jar", "/app/server.jar"]
