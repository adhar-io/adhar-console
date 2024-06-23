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
import { IoArgoprojWorkflowV1alpha1Arguments } from './ioArgoprojWorkflowV1alpha1Arguments';
import { IoArgoprojWorkflowV1alpha1ContinueOn } from './ioArgoprojWorkflowV1alpha1ContinueOn';
import { IoArgoprojWorkflowV1alpha1LifecycleHook } from './ioArgoprojWorkflowV1alpha1LifecycleHook';
import { IoArgoprojWorkflowV1alpha1Sequence } from './ioArgoprojWorkflowV1alpha1Sequence';
import { IoArgoprojWorkflowV1alpha1Template } from './ioArgoprojWorkflowV1alpha1Template';
import { IoArgoprojWorkflowV1alpha1TemplateRef } from './ioArgoprojWorkflowV1alpha1TemplateRef';

/**
* WorkflowStep is a reference to a template to execute in a series of step
*/
export class IoArgoprojWorkflowV1alpha1WorkflowStep {
    'arguments'?: IoArgoprojWorkflowV1alpha1Arguments;
    'continueOn'?: IoArgoprojWorkflowV1alpha1ContinueOn;
    /**
    * Hooks holds the lifecycle hook which is invoked at lifecycle of step, irrespective of the success, failure, or error status of the primary step
    */
    'hooks'?: { [key: string]: IoArgoprojWorkflowV1alpha1LifecycleHook; };
    'inline'?: IoArgoprojWorkflowV1alpha1Template;
    /**
    * Name of the step
    */
    'name'?: string;
    /**
    * OnExit is a template reference which is invoked at the end of the template, irrespective of the success, failure, or error of the primary template. DEPRECATED: Use Hooks[exit].Template instead.
    */
    'onExit'?: string;
    /**
    * Template is the name of the template to execute as the step
    */
    'template'?: string;
    'templateRef'?: IoArgoprojWorkflowV1alpha1TemplateRef;
    /**
    * When is an expression in which the step should conditionally execute
    */
    'when'?: string;
    /**
    * WithItems expands a step into multiple parallel steps from the items in the list
    */
    'withItems'?: Array<object>;
    /**
    * WithParam expands a step into multiple parallel steps from the value in the parameter, which is expected to be a JSON list.
    */
    'withParam'?: string;
    'withSequence'?: IoArgoprojWorkflowV1alpha1Sequence;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "arguments",
            "baseName": "arguments",
            "type": "IoArgoprojWorkflowV1alpha1Arguments"
        },
        {
            "name": "continueOn",
            "baseName": "continueOn",
            "type": "IoArgoprojWorkflowV1alpha1ContinueOn"
        },
        {
            "name": "hooks",
            "baseName": "hooks",
            "type": "{ [key: string]: IoArgoprojWorkflowV1alpha1LifecycleHook; }"
        },
        {
            "name": "inline",
            "baseName": "inline",
            "type": "IoArgoprojWorkflowV1alpha1Template"
        },
        {
            "name": "name",
            "baseName": "name",
            "type": "string"
        },
        {
            "name": "onExit",
            "baseName": "onExit",
            "type": "string"
        },
        {
            "name": "template",
            "baseName": "template",
            "type": "string"
        },
        {
            "name": "templateRef",
            "baseName": "templateRef",
            "type": "IoArgoprojWorkflowV1alpha1TemplateRef"
        },
        {
            "name": "when",
            "baseName": "when",
            "type": "string"
        },
        {
            "name": "withItems",
            "baseName": "withItems",
            "type": "Array<object>"
        },
        {
            "name": "withParam",
            "baseName": "withParam",
            "type": "string"
        },
        {
            "name": "withSequence",
            "baseName": "withSequence",
            "type": "IoArgoprojWorkflowV1alpha1Sequence"
        }    ];

    static getAttributeTypeMap() {
        return IoArgoprojWorkflowV1alpha1WorkflowStep.attributeTypeMap;
    }
}

