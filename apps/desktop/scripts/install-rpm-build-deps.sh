#!/usr/bin/env bash
# Run as root in the Rocky Linux 9 release build container.
set -euo pipefail
dnf install -y git tar gzip xz gcc gcc-c++ make python3 rpm-build \
  ruby ruby-devel rubygems redhat-rpm-config perl which findutils procps-ng desktop-file-utils
# electron-builder's downloaded FPM is not available for every Linux ARM host.
gem install fpm --version 1.17.0 --no-document
