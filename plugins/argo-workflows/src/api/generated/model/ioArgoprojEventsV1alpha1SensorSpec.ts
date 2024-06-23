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
import { IoArgoprojEventsV1alpha1EventDependency } from './ioArgoprojEventsV1alpha1EventDependency';
import { IoArgoprojEventsV1alpha1Template } from './ioArgoprojEventsV1alpha1Template';
import { IoArgoprojEventsV1alpha1Trigger } from './ioArgoprojEventsV1alpha1Trigger';

export class IoArgoprojEventsV1alpha1SensorSpec {
    /**
    * Dependencies is a list of the events that this sensor is dependent on.
    */
    'dependencies'?: Array<IoArgoprojEventsV1alpha1EventDependency>;
    /**
    * ErrorOnFailedRound if set to true, marks sensor state as `error` if the previous trigger round fails. Once sensor state is set to `error`, no further triggers will be processed.
    */
    'errorOnFailedRound'?: boolean;
    'eventBusName'?: string;
    'replicas'?: number;
    'template'?: IoArgoprojEventsV1alpha1Template;
    /**
    * Triggers is a list of the things that this sensor evokes. These are the outputs from this sensor.
    */
    'triggers'?: Array<IoArgoprojEventsV1alpha1Trigger>;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "dependencies",
            "baseName": "dependencies",
            "type": "Array<IoArgoprojEventsV1alpha1EventDependency>"
        },
        {
            "name": "errorOnFailedRound",
            "baseName": "errorOnFailedRound",
            "type": "boolean"
        },
        {
            "name": "eventBusName",
            "baseName": "eventBusName",
            "type": "string"
        },
        {
            "name": "replicas",
            "baseName": "replicas",
            "type": "number"
        },
        {
            "name": "template",
            "baseName": "template",
            "type": "IoArgoprojEventsV1alpha1Template"
        },
        {
            "name": "triggers",
            "baseName": "triggers",
            "type": "Array<IoArgoprojEventsV1alpha1Trigger>"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojEventsV1alpha1SensorSpec.attributeTypeMap;
    }
}

