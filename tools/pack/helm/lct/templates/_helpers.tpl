{{- /*
LCT Helm chart helpers. Spec §15.5.

Names:
  lct.name        chart-name (`lct`)
  lct.fullname    release-prefixed name (truncated to 63 chars)
  lct.labels      common label set
  lct.selectorLabels   selector subset
*/ -}}

{{- define "lct.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "lct.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "lct.labels" -}}
app.kubernetes.io/name: {{ include "lct.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{- define "lct.selectorLabels" -}}
app.kubernetes.io/name: {{ include "lct.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
