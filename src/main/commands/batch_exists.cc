/*******************************************************************************
 * Copyright 2013-2020 Aerospike, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 ******************************************************************************/

#include "client.h"
#include "command.h"
#include "async.h"
#include "conversions.h"
#include "policy.h"
#include "log.h"

extern "C" {
#include <aerospike/aerospike.h>
#include <aerospike/aerospike_key.h>
#include <aerospike/as_config.h>
#include <aerospike/as_key.h>
#include <aerospike/as_record.h>
#include <aerospike/aerospike_batch.h>
}

using namespace v8;

class BatchExistsCommand : public AerospikeCommand {
  public:
	BatchExistsCommand(AerospikeClient *client, Local<Function> callback_)
		: AerospikeCommand("BatchExists", client, callback_)
	{
	}

	~BatchExistsCommand()
	{
		if (policy != NULL)
			cf_free(policy);
		if (results != NULL)
			cf_free(results);
	}

	as_policy_batch *policy = NULL;
	as_batch batch;
	as_batch_read *results = NULL;
	uint32_t results_len = 0;
};

bool batch_exists_callback(const as_batch_read *results, uint32_t n,
						   void *udata)
{
	BatchExistsCommand *cmd = reinterpret_cast<BatchExistsCommand *>(udata);
	LogInfo *log = cmd->log;

	as_v8_debug(log, "BatchExists callback invoked with %d batch results", n);

	if (results == NULL) {
		cmd->results = NULL;
		cmd->results_len = 0;
		return false;
	}

	// Copy the batch result to the shared data structure BatchExistsCommand,
	// so that response can send it back to nodejs layer.
	cmd->results = (as_batch_read *)calloc(n, sizeof(as_batch_read));
	cmd->results_len = n;
	for (uint32_t i = 0; i < n; i++) {
		cmd->results[i].result = results[i].result;
		key_clone(results[i].key, (as_key **)&cmd->results[i].key, log);
		if (results[i].result == AEROSPIKE_OK) {
			as_record *rec = &cmd->results[i].record;
			record_clone(&results[i].record, &rec, log);
		}
	}

	return true;
}

static void *prepare(const Nan::FunctionCallbackInfo<Value> &info)
{
	Nan::HandleScope scope;
	AerospikeClient *client =
		Nan::ObjectWrap::Unwrap<AerospikeClient>(info.This());
	BatchExistsCommand *cmd =
		new BatchExistsCommand(client, info[2].As<Function>());
	LogInfo *log = client->log;

	Local<Array> keys = info[0].As<Array>();
	if (batch_from_jsarray(&cmd->batch, keys, log) != AS_NODE_PARAM_OK) {
		return CmdSetError(cmd, AEROSPIKE_ERR_PARAM,
						   "Batch keys parameter invalid");
	}

	if (info[1]->IsObject()) {
		cmd->policy = (as_policy_batch *)cf_malloc(sizeof(as_policy_batch));
		if (batchpolicy_from_jsobject(cmd->policy, info[1].As<Object>(), log) !=
			AS_NODE_PARAM_OK) {
			return CmdSetError(cmd, AEROSPIKE_ERR_PARAM,
							   "Batch policy parameter invalid");
		}
	}

	return cmd;
}

static void execute(uv_work_t *req)
{
	BatchExistsCommand *cmd = reinterpret_cast<BatchExistsCommand *>(req->data);
	LogInfo *log = cmd->log;

	if (!cmd->CanExecute()) {
		return;
	}

	as_v8_debug(log, "Executing BatchExists command for %d keys",
				cmd->batch.keys.size);
	if (aerospike_batch_exists(cmd->as, &cmd->err, cmd->policy, &cmd->batch,
							   batch_exists_callback, cmd) != AEROSPIKE_OK) {
		cmd->results = NULL;
		cmd->results_len = 0;
	}
	as_batch_destroy(&cmd->batch);
	if (cmd->policy && cmd->policy->base.filter_exp) {
		as_exp_destroy(cmd->policy->base.filter_exp);
	}
}

static void respond(uv_work_t *req, int status)
{
	Nan::HandleScope scope;
	BatchExistsCommand *cmd = reinterpret_cast<BatchExistsCommand *>(req->data);
	LogInfo *log = cmd->log;

	if (cmd->IsError()) {
		cmd->ErrorCallback();
	}
	else {
		as_batch_read *batch_results = cmd->results;
		Local<Array> results = Nan::New<Array>(cmd->results_len);
		for (uint32_t i = 0; i < cmd->results_len; i++) {
			as_status status = batch_results[i].result;
			as_record *record = &batch_results[i].record;
			const as_key *key = batch_results[i].key;

			Local<Object> result = Nan::New<Object>();
			Nan::Set(result, Nan::New("status").ToLocalChecked(),
					 Nan::New(status));
			Nan::Set(result, Nan::New("key").ToLocalChecked(),
					 key_to_jsobject(key, log));

			if (batch_results[i].result == AEROSPIKE_OK) {
				Nan::Set(result, Nan::New("meta").ToLocalChecked(),
						 recordmeta_to_jsobject(record, log));
			}
			else {
				as_v8_debug(log, "Record [%d] not returned by server", i);
			}

			as_key_destroy((as_key *)key);
			as_record_destroy(record);
			Nan::Set(results, i, result);
		}

		Local<Value> argv[] = {Nan::Null(), results};
		cmd->Callback(2, argv);
	}

	delete cmd;
	delete req;
}

NAN_METHOD(AerospikeClient::BatchExists)
{
	TYPE_CHECK_REQ(info[0], IsArray, "Keys must be a array");
	TYPE_CHECK_OPT(info[1], IsObject, "Policy must be an object");
	TYPE_CHECK_REQ(info[2], IsFunction, "Callback must be a function");

	async_invoke(info, prepare, execute, respond);
}
