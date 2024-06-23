// @ts-nocheck
/**
 * Argo Workflows API
 * Argo Workflows is an open source container-native workflow engine for orchestrating parallel jobs on Kubernetes. For more information, please see https://argoproj.github.io/argo-workflows/
 *
 * The version of the OpenAPI document: VERSION
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */

import { RequestFile } from './models';
import { IoArgoprojEventsV1alpha1Backoff } from './ioArgoprojEventsV1alpha1Backoff';
import { IoArgoprojEventsV1alpha1EventSourceFilter } from './ioArgoprojEventsV1alpha1EventSourceFilter';
import { IoArgoprojEventsV1alpha1TLSConfig } from './ioArgoprojEventsV1alpha1TLSConfig';
import { IoK8sApiCoreV1SecretKeySelector } from './ioK8sApiCoreV1SecretKeySelector';

export class IoArgoprojEventsV1alpha1PulsarEventSource {
    'authTokenSecret'?: IoK8sApiCoreV1SecretKeySelector;
    'connectionBackoff'?: IoArgoprojEventsV1alpha1Backoff;
    'filter'?: IoArgoprojEventsV1alpha1EventSourceFilter;
    'jsonBody'?: boolean;
    'metadata'?: { [key: string]: string; };
    'tls'?: IoArgoprojEventsV1alpha1TLSConfig;
    'tlsAllowInsecureConnection'?: boolean;
    'tlsTrustCertsSecret'?: IoK8sApiCoreV1SecretKeySelector;
    'tlsValidateHostname'?: boolean;
    'topics'?: Array<string>;
    'type'?: string;
    'url'?: string;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "authTokenSecret",
            "baseName": "authTokenSecret",
            "type": "IoK8sApiCoreV1SecretKeySelector"
        },
        {
            "name": "connectionBackoff",
            "baseName": "connectionBackoff",
            "type": "IoArgoprojEventsV1alpha1Backoff"
        },
        {
            "name": "filter",
            "baseName": "filter",
            "type": "IoArgoprojEventsV1alpha1EventSourceFilter"
        },
        {
            "name": "jsonBody",
            "baseName": "jsonBody",
            "type": "boolean"
        },
        {
            "name": "metadata",
            "baseName": "metadata",
            "type": "{ [key: string]: string; }"
        },
        {
            "name": "tls",
            "baseName": "tls",
            "type": "IoArgoprojEventsV1alpha1TLSConfig"
        },
        {
            "name": "tlsAllowInsecureConnection",
            "baseName": "tlsAllowInsecureConnection",
            "type": "boolean"
        },
        {
            "name": "tlsTrustCertsSecret",
            "baseName": "tlsTrustCertsSecret",
            "type": "IoK8sApiCoreV1SecretKeySelector"
        },
        {
            "name": "tlsValidateHostname",
            "baseName": "tlsValidateHostname",
            "type": "boolean"
        },
        {
            "name": "topics",
            "baseName": "topics",
            "type": "Array<string>"
        },
        {
            "name": "type",
            "baseName": "type",
            "type": "string"
        },
        {
            "name": "url",
            "baseName": "url",
            "type": "string"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojEventsV1alpha1PulsarEventSource.attributeTypeMap;
    }
}

