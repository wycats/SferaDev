export * from "./client";

import * as AccountComponents from "./account/generated/components";
import * as AccountSchemas from "./account/generated/schemas";
import * as AccountTypes from "./account/generated/types";
import * as AdminComponents from "./admin/generated/components";
import * as AdminSchemas from "./admin/generated/schemas";
import * as AdminTypes from "./admin/generated/types";

const {
	operationsByPath: adminOperationsByPath,
	operationsByTag: adminOperationsByTag,
	tagDictionary: adminTagDictionary,
	...AdminFetchers
} = AdminComponents;

const {
	operationsByPath: accountOperationsByPath,
	operationsByTag: accountOperationsByTag,
	tagDictionary: accountTagDictionary,
	...AccountFetchers
} = AccountComponents;

const AdminHelpers = {
	operationsByPath: adminOperationsByPath,
	operationsByTag: adminOperationsByTag,
	tagDictionary: adminTagDictionary,
};

const AccountHelpers = {
	operationsByPath: accountOperationsByPath,
	operationsByTag: accountOperationsByTag,
	tagDictionary: accountTagDictionary,
};

export {
	AdminFetchers,
	AdminHelpers,
	AdminSchemas,
	AdminTypes,
	AccountFetchers,
	AccountHelpers,
	AccountSchemas,
	AccountTypes,
};
