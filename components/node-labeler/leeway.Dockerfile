# Copyright (c) 2020 Gitpod GmbH. All rights reserved.
# Licensed under the GNU Affero General Public License (AGPL).
# See License.AGPL.txt in the project root for license information.

FROM cgr.dev/chainguard/wolfi-base:latest@sha256:5fd82be4dfccc650c1985d57847f1af556bf23a8a5d86ec5fddf7d417ab147a4

COPY components-node-labeler--app/node-labeler /app/node-labeler

ARG __GIT_COMMIT
ARG VERSION

ENV GITPOD_BUILD_GIT_COMMIT=${__GIT_COMMIT}
ENV GITPOD_BUILD_VERSION=${VERSION}
ENTRYPOINT [ "/app/node-labeler" ]
CMD [ "-v", "help" ]
