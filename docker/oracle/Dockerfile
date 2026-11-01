# Oracle AI Database 26ai Free + ORDS + Oracle API for MongoDB.
#
# Adapted from the converged-modeling-patterns lab image (app schema renamed to MIG).
#   * gvenzl faststart release line 23.26.3 (year.quarter numbering; the 23.26.x
#     line IS the 26ai release). The base image is multi-arch (amd64 + arm64).
#   * No vector/ONNX model layer: the migration demos use no vectors.
#     This image is DB + ORDS + mongosh, nothing more.
FROM docker.io/gvenzl/oracle-free:23.26.3-faststart

USER root

# --- ORDS (latest) -----------------------------------------------------------
# Installs Oracle REST Data Services, which fronts both the Database API and the
# Oracle API for MongoDB (port 27017).
COPY scripts/install-ords.sh /tmp/install-ords.sh
RUN chmod +x /tmp/install-ords.sh && /tmp/install-ords.sh && rm /tmp/install-ords.sh
RUN chown -R oracle:oinstall /etc/ords

# --- mongosh (current MongoDB 8.0 repo) --------------------------------------
# mongosh in-container lets demos run Mongo shell commands against the Oracle API.
# $basearch lets dnf pick x86_64 or aarch64, so the image also builds on Apple silicon.
RUN printf '[mongodb-org-8.0]\nname=MongoDB Repository\nbaseurl=https://repo.mongodb.org/yum/redhat/8/mongodb-org/8.0/$basearch/\ngpgcheck=1\nenabled=1\ngpgkey=https://pgp.mongodb.com/server-8.0.asc\n' > /etc/yum.repos.d/mongodb-org-8.0.repo \
 && microdnf install -y mongodb-mongosh \
 && microdnf clean all

# --- schema init + custom entrypoint -----------------------------------------
# initdb scripts pre-create MIG and grant the privileges the demos use. The entrypoint
# installs ORDS, ORDS-enables MIG, and turns the Mongo API on (TLS off for
# local dev), then starts both Oracle and ORDS.
COPY init/ /container-entrypoint-initdb.d/
COPY scripts/entrypoint.sh /opt/oracle/scripts/entrypoint.sh
RUN chmod +x /opt/oracle/scripts/entrypoint.sh

USER oracle
EXPOSE 1521 8181 27017
ENTRYPOINT ["/opt/oracle/scripts/entrypoint.sh"]
