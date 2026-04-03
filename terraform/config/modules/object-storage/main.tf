data "oci_objectstorage_namespace" "current" {
  compartment_id = var.compartment_id
}

resource "oci_objectstorage_bucket" "s3_proxy" {
  compartment_id = var.compartment_id
  namespace      = data.oci_objectstorage_namespace.current.namespace
  name           = "s3-proxy"
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
}
