# Official image, unmodified. Upgrading is a tag change — unlike the lambda-web
# crate patch used by darioackermann/vaultwarden-serverless, which pins that
# project to a 2023 build of Vaultwarden.
#
# ARG must be declared before FROM to be usable in it. The default lets a bare
# `docker build` still work; the CDK asset build overrides it via --build-arg
# from Application's `imageTag` prop.
ARG VW_TAG=1.35.1-alpine
FROM vaultwarden/server:${VW_TAG}

# The adapter runs as a Lambda external extension and proxies invocations to the
# Rocket server over localhost. The public ECR image is multi-arch, so this one
# tag covers arm64.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.1 /lambda-adapter /opt/extensions/lambda-adapter

# The official image defaults ROCKET_PORT to 80. Both sides must agree.
ENV ROCKET_PORT=8080 \
    ROCKET_ADDRESS=0.0.0.0 \
    AWS_LWA_PORT=8080 \
    AWS_LWA_READINESS_CHECK_PATH=/alive \
    AWS_LWA_ASYNC_INIT=true
