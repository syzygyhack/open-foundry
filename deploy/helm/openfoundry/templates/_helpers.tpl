{{/*
Expand the name of the chart.
*/}}
{{- define "openfoundry.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openfoundry.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "openfoundry.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "openfoundry.labels" -}}
helm.sh/chart: {{ include "openfoundry.chart" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: openfoundry
{{- end }}

{{/*
Selector labels for a specific component.
*/}}
{{- define "openfoundry.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .release }}
{{- end }}

{{/*
PostgreSQL connection URL.
*/}}
{{- define "openfoundry.postgresUrl" -}}
postgresql://$(POSTGRES_USERNAME):$(POSTGRES_PASSWORD)@{{ .Values.storage.postgres.host }}:{{ .Values.storage.postgres.port }}/{{ .Values.storage.postgres.database }}
{{- end }}

{{/*
Service account name.
HELM-14: Explicit service account for all deployments.
Falls back to release-scoped name (not cluster default) when no override is set.
*/}}
{{- define "openfoundry.serviceAccountName" -}}
{{- if and .Values.serviceAccount .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name }}
{{- else -}}
{{- include "openfoundry.fullname" . }}
{{- end -}}
{{- end }}

{{/*
Image reference for a service: repository@digest when the service sets a
digest, otherwise repository:tag (the service's tag, else the release's).
An unset, null or empty digest means no digest; any other value must be
sha256: and 64 lowercase hex digits.
The repository defaults to <image.registry>/<name>, name being the published
image name; key is the service's values key, for error messages.
*/}}
{{- define "openfoundry.image" -}}
{{- $repo := default (printf "%s/%s" .global.registry .name) .svc.repository -}}
{{- $digest := "" -}}
{{- if and (hasKey .svc "digest") (not (kindIs "invalid" .svc.digest)) -}}
{{- $digest = toString .svc.digest -}}
{{- end -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail (printf "%s.image.digest must be sha256: followed by 64 lowercase hex digits (got %q)" .key $digest) -}}
{{- end -}}
{{ $repo }}@{{ $digest }}
{{- else -}}
{{ $repo }}:{{ default .global.tag .svc.tag }}
{{- end -}}
{{- end }}
