import { assembleContractScm } from './test-support/assembly.js';
import { githubContract } from '../../test-support/github/contract-binding.js';
githubContract('replay', assembleContractScm);
