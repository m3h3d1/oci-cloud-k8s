#!/usr/bin/env bash
set -euo pipefail

# Upload a disposable object slightly above the 10 GB Always Free allocation.
BUCKET="${OCI_OBJECT_STORAGE_BUCKET:-storage-lab-disposable-20260731}"
OBJECT_NAME="${OCI_OBJECT_STORAGE_OBJECT:-storage-lab-11gib-zero.bin}"
SIZE_GIB="${OCI_OBJECT_STORAGE_SIZE_GIB:-11}"

for command in oci perl truncate; do
  command -v "$command" >/dev/null || {
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  }
done

[[ "$SIZE_GIB" =~ ^[1-9][0-9]*$ ]] || {
  printf 'OCI_OBJECT_STORAGE_SIZE_GIB must be a positive integer.\n' >&2
  exit 1
}

namespace="$(oci os ns get --query data --raw-output)"
file="$(mktemp --tmpdir storage-lab-XXXXXX.bin)"
size_bytes=$((SIZE_GIB * 1024 * 1024 * 1024))

cleanup() {
  rm -f "$file"
}
trap cleanup EXIT

truncate -s "$size_bytes" "$file"

printf 'Streaming %s GiB to %s/%s\n' "$SIZE_GIB" "$BUCKET" "$OBJECT_NAME"

# OCI uses multipart upload from stdin. Perl prints a progress bar to stderr
# while forwarding the sparse file's zero bytes to the OCI CLI.
perl -e '
  use strict;
  use warnings;
  my $total = shift;
  my $sent = 0;
  my $width = 40;
  binmode STDIN;
  binmode STDOUT;
  while (read(STDIN, my $buffer, 1024 * 1024)) {
    print STDOUT $buffer;
    $sent += length $buffer;
    my $percent = int($sent * 100 / $total);
    my $filled = int($percent * $width / 100);
    printf STDERR "\r[%s%s] %3d%% (%0.2f / %0.2f GiB)",
      "#" x $filled, "." x ($width - $filled), $percent,
      $sent / 1073741824, $total / 1073741824;
  }
  print STDERR "\n";
' "$size_bytes" <"$file" |
  oci os object put \
    --namespace "$namespace" \
    --bucket-name "$BUCKET" \
    --file - \
    --name "$OBJECT_NAME" \
    --part-size 128 \
    --disable-parallel-uploads \
    --no-overwrite \
    --content-type application/octet-stream \
    --output json >/dev/null

remote_size="$(oci os object head \
  --namespace "$namespace" \
  --bucket-name "$BUCKET" \
  --name "$OBJECT_NAME" \
  --query '"content-length"' \
  --raw-output)"

[[ "$remote_size" == "$size_bytes" ]] || {
  printf 'Upload completed but remote size is %s bytes; expected %s.\n' "$remote_size" "$size_bytes" >&2
  exit 1
}

printf 'Verified %s bytes. Local temporary file removed.\n' "$remote_size"
